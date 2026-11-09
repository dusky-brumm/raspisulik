import { Unzip, Zip, ZipPassThrough } from 'fflate';
import type { WorkoutSnapshot } from './video-store.ts';
import {
  MAX_WORKOUT_MANIFEST_BYTES,
  MAX_WORKOUT_MEDIA_BYTES,
  parseWorkoutLibrary,
} from './workout-validation.ts';

const CHUNK_SIZE = 64 * 1024;
const MAX_ARCHIVE_BYTES = MAX_WORKOUT_MEDIA_BYTES + MAX_WORKOUT_MANIFEST_BYTES + 2 * 1024 * 1024;
const MANIFEST = 'manifest.json';
interface MediaEntry {
  clipId: string;
  path: string;
  size: number;
  sha256: string;
}
export interface ArchiveProgress {
  phase: 'preparing' | 'exporting' | 'reading' | 'checking';
  completed: number;
  total: number;
}
interface Options {
  signal?: AbortSignal;
  progress?: (progress: ArchiveProgress) => void;
}
const pathFor = (id: string) => `media/${id}`;
const localClips = (snapshot: WorkoutSnapshot) =>
  snapshot.library.clips.filter((clip) => !clip.youtubeId && !clip.exercise);

function active(options: Options) {
  options.signal?.throwIfAborted();
}
async function digest(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function progress(options: Options, phase: ArchiveProgress['phase'], completed: number, total: number) {
  active(options);
  options.progress?.({ phase, completed, total });
}

/** Stored ZIP streams keep already compressed videos out of compression workers. */
export async function exportWorkoutArchive(snapshot: WorkoutSnapshot, options: Options = {}): Promise<Blob> {
  const library = parseWorkoutLibrary(snapshot.library, 'personal');
  const clips = localClips(snapshot),
    media: MediaEntry[] = [];
  const total = clips.reduce((sum, clip) => sum + clip.size, 0);
  let prepared = 0;
  for (const clip of clips) {
    progress(options, 'preparing', prepared, total);
    const blob = snapshot.media.get(clip.id);
    if (!blob || blob.size !== clip.size)
      throw new Error(`Файл «${clip.title}» недоступен. Добавьте исходное видео перед экспортом.`);
    const sha256 = await digest(blob);
    active(options);
    media.push({ clipId: clip.id, path: pathFor(clip.id), size: blob.size, sha256 });
    prepared += blob.size;
  }
  const checksum = await digest(new Blob([JSON.stringify({ library, media })]));
  const manifest = new Blob(
    [
      JSON.stringify({
        format: 'raspisulik-workouts',
        version: 1,
        createdAt: new Date().toISOString(),
        library,
        media,
        checksum,
      }),
    ],
    { type: 'application/json' },
  );
  if (manifest.size > MAX_WORKOUT_MANIFEST_BYTES) throw new Error('Слишком много данных для одного архива.');
  const parts: Blob[] = [];
  let finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) throw error;
    parts.push(new Blob([new Uint8Array(data)]));
    if (final) finished = true;
  });
  let written = 0;
  async function append(path: string, blob: Blob, count = true) {
    const entry = new ZipPassThrough(path);
    zip.add(entry);
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      active(options);
      const chunk = new Uint8Array(await blob.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
      entry.push(chunk, offset + chunk.length === blob.size);
      if (count) {
        written += chunk.length;
        progress(options, 'exporting', written, total);
      }
    }
    if (blob.size === 0) entry.push(new Uint8Array(), true);
  }
  try {
    await append(MANIFEST, manifest, false);
    for (const entry of media) await append(entry.path, snapshot.media.get(entry.clipId)!);
    zip.end();
    if (!finished) throw new Error('Не удалось завершить архив. Повторите экспорт.');
    active(options);
    return new Blob(parts, { type: 'application/zip' });
  } catch (error) {
    zip.terminate();
    throw error;
  }
}

async function validateZipEnd(file: Blob): Promise<number> {
  // This app writes no ZIP comments or split volumes. Reject truncated archives early.
  if (file.size < 22 || file.size > MAX_ARCHIVE_BYTES)
    throw new Error('Выберите ZIP-архив Расписулика размером до 522 МБ.');
  const tail = new DataView(await file.slice(-22).arrayBuffer());
  if (
    tail.getUint32(0, true) !== 0x06054b50 ||
    tail.getUint16(4, true) !== 0 ||
    tail.getUint16(6, true) !== 0 ||
    tail.getUint16(8, true) !== tail.getUint16(10, true) ||
    tail.getUint16(20, true) !== 0 ||
    tail.getUint32(12, true) + tail.getUint32(16, true) !== file.size - 22
  ) {
    throw new Error('Архив повреждён или создан другой программой. Выберите исходный экспорт Расписулика.');
  }
  return tail.getUint16(10, true);
}

/** Validate every record and file hash before the caller is allowed to write anything. */
export async function readWorkoutArchive(file: Blob, options: Options = {}): Promise<WorkoutSnapshot> {
  active(options);
  const expectedEntries = await validateZipEnd(file);
  if (!expectedEntries || expectedEntries > 5001)
    throw new Error('Неверное количество файлов в архиве тренировок.');
  const entries = new Map<string, Blob>();
  const seen = new Set<string>();
  let pending = 0,
    totalSize = 0,
    failure: unknown;
  const unzip = new Unzip((entry) => {
    if (
      seen.has(entry.name) ||
      !/^(manifest\.json|media\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79})$/.test(entry.name) ||
      entry.compression !== 0 ||
      seen.size >= 5001
    ) {
      throw new Error('Это не поддерживаемый архив тренировок Расписулика.');
    }
    seen.add(entry.name);
    pending++;
    const chunks: Blob[] = [];
    let size = 0;
    entry.ondata = (error, data, final) => {
      if (error) {
        failure = error;
        return;
      }
      size += data.length;
      totalSize += data.length;
      if (
        size > (entry.name === MANIFEST ? MAX_WORKOUT_MANIFEST_BYTES : MAX_WORKOUT_MEDIA_BYTES / 2) ||
        totalSize > MAX_WORKOUT_MEDIA_BYTES + MAX_WORKOUT_MANIFEST_BYTES
      ) {
        failure = new Error('Архив превышает допустимый размер.');
        entry.terminate();
        return;
      }
      chunks.push(new Blob([new Uint8Array(data)]));
      if (final) {
        entries.set(entry.name, new Blob(chunks));
        pending--;
      }
    };
    entry.start();
  });
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    active(options);
    const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    try {
      unzip.push(chunk, offset + chunk.length === file.size);
    } catch {
      throw new Error('Не удалось прочитать архив. Выберите исходный ZIP-файл Расписулика.');
    }
    if (failure) throw failure;
    progress(options, 'reading', offset + chunk.length, file.size);
  }
  if (pending || seen.size !== expectedEntries || !entries.has(MANIFEST))
    throw new Error('В архиве отсутствуют данные или видеофайлы.');
  let value: unknown;
  try {
    value = JSON.parse(await entries.get(MANIFEST)!.text());
  } catch {
    throw new Error('Не удалось прочитать описание архива тренировок.');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('format' in value) ||
    value.format !== 'raspisulik-workouts' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('library' in value) ||
    !('media' in value) ||
    !Array.isArray(value.media) ||
    !('checksum' in value) ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.checksum)
  ) {
    throw new Error('Эта версия архива тренировок не поддерживается.');
  }
  if (
    (await digest(new Blob([JSON.stringify({ library: value.library, media: value.media })]))) !==
    value.checksum
  ) {
    throw new Error('Описание архива повреждено. Выберите другую копию ZIP-файла.');
  }
  active(options);
  const library = parseWorkoutLibrary(value.library, 'personal');
  const clips = localClips({ library, media: new Map() });
  if (value.media.length !== clips.length || entries.size !== clips.length + 1)
    throw new Error('Состав видеофайлов не совпадает с описанием архива.');
  const media = new Map<string, Blob>();
  const mediaEntries = value.media as unknown[];
  let checked = 0;
  const total = clips.reduce((sum, clip) => sum + clip.size, 0);
  for (const clip of clips) {
    const entry = mediaEntries.find(
      (item) => item && typeof item === 'object' && 'clipId' in item && item.clipId === clip.id,
    );
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('path' in entry) ||
      entry.path !== pathFor(clip.id) ||
      !('size' in entry) ||
      entry.size !== clip.size ||
      !('sha256' in entry) ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`В архиве неверно описан файл «${clip.title}».`);
    }
    const blob = entries.get(pathFor(clip.id));
    if (!blob || blob.size !== clip.size)
      throw new Error(`В архиве отсутствует или повреждён файл «${clip.title}».`);
    progress(options, 'checking', checked, total);
    if ((await digest(blob)) !== entry.sha256)
      throw new Error(`Файл «${clip.title}» повреждён. Выберите другую копию архива.`);
    active(options);
    media.set(clip.id, blob.slice(0, blob.size, clip.type));
    checked += blob.size;
  }
  progress(options, 'checking', total, total);
  return { library, media };
}
