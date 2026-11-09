import { validDate } from './domain.ts';
import type { Dataset, DateKey } from './domain.ts';
import { parseWorkoutLibrary } from './workout-validation.ts';

export interface VideoCollection {
  id: string;
  dataset: Dataset;
  title: string;
  activityId?: string;
  createdAt: string;
}
export interface ExerciseInstructions {
  repetitions: string;
  instructions: string;
  sourceUrl?: string;
}
export interface ExerciseInput extends ExerciseInstructions {
  title: string;
}
export interface VideoClip {
  id: string;
  collectionId: string;
  title: string;
  filename: string;
  source: string;
  size: number;
  modified: number;
  type: string;
  order: number;
  hidden: boolean;
  youtubeId?: string;
  exercise?: ExerciseInstructions;
}
export interface VideoMark {
  id: string;
  collectionId: string;
  videoId: string;
  date: DateKey;
  completedAt: string;
}
export interface VideoLibrary {
  collections: VideoCollection[];
  clips: VideoClip[];
  marks: VideoMark[];
}
export interface WorkoutSnapshot {
  library: VideoLibrary;
  media: Map<string, Blob>;
}
const videoExtensions = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv|avi)$/i;
export function isVideoFile(file: Pick<File, 'name' | 'type' | 'size'>) {
  return file.size > 0 && (file.type.startsWith('video/') || videoExtensions.test(file.name));
}
export function videoTitle(filename: string) {
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/[_]+/g, ' ')
      .trim()
      .slice(0, 180) || 'Видео'
  );
}
export function youtubeIdFromUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Укажите полную ссылку на ролик YouTube.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('Нужна безопасная ссылка https:// на YouTube.');
  let id: string | null = null;
  if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) id = url.pathname.split('/')[1];
  else if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'www.youtube-nocookie.com',
    ].includes(url.hostname)
  ) {
    const parts = url.pathname.split('/');
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live'].includes(parts[1])) id = parts[2];
  }
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new Error('Не удалось найти ролик в ссылке YouTube.');
  return id;
}
export function videoProgress(clips: VideoClip[], marks: VideoMark[], collectionId: string, date: DateKey) {
  const active = clips.filter((c) => c.collectionId === collectionId && !c.hidden);
  const done = new Set(
    marks.filter((m) => m.collectionId === collectionId && m.date === date).map((m) => m.videoId),
  );
  const completed = active.filter((c) => done.has(c.id)).length;
  return { completed, total: active.length, allDone: active.length > 0 && completed === active.length };
}
function title(value: string) {
  const text = value.trim();
  if (!text || text.length > 180) throw new Error('Введите название до 180 символов.');
  return text;
}
function exerciseInput(value: ExerciseInput): ExerciseInput {
  const name = title(value.title),
    repetitions = value.repetitions.trim(),
    instructions = value.instructions.trim();
  if (!repetitions || repetitions.length > 180)
    throw new Error('Укажите повторы или длительность до 180 символов.');
  if (!instructions || instructions.length > 4000) throw new Error('Добавьте инструкцию до 4000 символов.');
  let sourceUrl: string | undefined;
  if (value.sourceUrl?.trim()) {
    let url: URL;
    try {
      url = new URL(value.sourceUrl.trim());
    } catch {
      throw new Error('Укажите полную ссылку на источник.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048)
      throw new Error('Источник должен быть безопасной ссылкой https://.');
    sourceUrl = url.href;
  }
  return { title: name, repetitions, instructions, ...(sourceUrl ? { sourceUrl } : {}) };
}
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Blobs stay in their own store: loading the library never loads video contents. */
export function createVideoStore(options: { name: string; factory?: IDBFactory; now?: () => Date }) {
  let opened: Promise<IDBDatabase> | undefined;
  const now = options.now ?? (() => new Date());
  function database() {
    if (!opened)
      opened = new Promise<IDBDatabase>((resolve, reject) => {
        const factory = options.factory ?? globalThis.indexedDB;
        if (!factory) {
          reject(new Error('Браузер не поддерживает хранение видео.'));
          return;
        }
        const opening = factory.open(options.name, 1);
        opening.onupgradeneeded = () => {
          const db = opening.result;
          db.createObjectStore('collections', { keyPath: 'id' }).createIndex('dataset', 'dataset');
          db.createObjectStore('clips', { keyPath: 'id' }).createIndex('collection', 'collectionId');
          db.createObjectStore('media');
          db.createObjectStore('marks', { keyPath: 'id' }).createIndex('day', ['collectionId', 'date']);
        };
        opening.onerror = () => {
          opened = undefined;
          reject(opening.error);
        };
        opening.onblocked = () => {
          opened = undefined;
          reject(new Error('Закройте другие вкладки Расписулика и повторите.'));
        };
        opening.onsuccess = () => {
          const db = opening.result;
          db.onversionchange = () => {
            db.close();
            opened = undefined;
          };
          resolve(db);
        };
      });
    return opened;
  }
  async function transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T, failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Не удалось сохранить видео.'));
      void work(tx)
        .then((value) => {
          result = value;
        })
        .catch((error) => {
          failure = error;
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        });
    });
  }
  async function collection(tx: IDBTransaction, dataset: Dataset, id: string): Promise<VideoCollection> {
    const value = await request<VideoCollection | undefined>(tx.objectStore('collections').get(id));
    if (!value || value.dataset !== dataset) throw new Error('Подборка не найдена. Обновите список.');
    return value;
  }
  async function uniqueLink(tx: IDBTransaction, dataset: Dataset, activityId?: string, except?: string) {
    if (!activityId) return;
    const rows = await request<VideoCollection[]>(
      tx.objectStore('collections').index('dataset').getAll(dataset),
    );
    if (rows.some((c) => c.activityId === activityId && c.id !== except))
      throw new Error('К этой задаче уже привязана другая подборка.');
  }
  async function list(dataset: Dataset, date: DateKey): Promise<VideoLibrary> {
    if (!validDate(date)) throw new Error('Выберите действительную дату.');
    return transaction(['collections', 'clips', 'marks'], 'readonly', async (tx) => {
      const collections = await request<VideoCollection[]>(
        tx.objectStore('collections').index('dataset').getAll(dataset),
      );
      collections.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const groups = await Promise.all(
        collections.map(async (c) => ({
          clips: await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(c.id)),
          marks: await request<VideoMark[]>(tx.objectStore('marks').index('day').getAll([c.id, date])),
        })),
      );
      return {
        collections,
        clips: groups.flatMap((g) => g.clips).sort((a, b) => a.order - b.order),
        marks: groups.flatMap((g) => g.marks),
      };
    });
  }
  async function getCollections(dataset: Dataset): Promise<VideoCollection[]> {
    return transaction(['collections'], 'readonly', async (tx) => {
      const values = await request<VideoCollection[]>(
        tx.objectStore('collections').index('dataset').getAll(dataset),
      );
      return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    });
  }
  async function create(dataset: Dataset, name: string, activityId?: string) {
    const value: VideoCollection = {
      id: crypto.randomUUID(),
      dataset,
      title: title(name),
      createdAt: now().toISOString(),
      ...(activityId ? { activityId } : {}),
    };
    return transaction(['collections'], 'readwrite', async (tx) => {
      await uniqueLink(tx, dataset, activityId);
      await request(tx.objectStore('collections').add(value));
      return value;
    });
  }
  async function updateCollection(dataset: Dataset, id: string, name: string, activityId?: string) {
    const nameText = title(name);
    return transaction(['collections'], 'readwrite', async (tx) => {
      const current = await collection(tx, dataset, id);
      await uniqueLink(tx, dataset, activityId, id);
      const value = { ...current, title: nameText, activityId };
      await request(tx.objectStore('collections').put(value));
      return value;
    });
  }
  async function addFiles(dataset: Dataset, id: string, files: File[]) {
    const videos = files
      .filter(isVideoFile)
      .sort((a, b) =>
        (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'ru', {
          numeric: true,
        }),
      );
    if (!videos.length)
      throw new Error('В выбранных файлах нет видео. Выберите MP4, WebM или другой видеофайл.');
    if (videos.length > 200) throw new Error('Добавьте не больше 200 роликов за один раз.');
    return transaction(['collections', 'clips', 'media'], 'readwrite', async (tx) => {
      await collection(tx, dataset, id);
      const existing = await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(id));
      let order = Math.max(-1, ...existing.map((c) => c.order)) + 1,
        added = 0,
        restored = 0;
      for (const file of videos) {
        const source = file.webkitRelativePath || file.name;
        const same = existing.find(
          (c) =>
            c.size === file.size &&
            c.modified === file.lastModified &&
            (c.source === source ||
              (c.filename === file.name && (!c.source.includes('/') || !source.includes('/')))),
        );
        if (same) {
          let recovered = false;
          if (!same.source.includes('/') && source.includes('/')) {
            same.source = source;
            await request(tx.objectStore('clips').put(same));
          }
          if (same.hidden) {
            same.hidden = false;
            same.order = order++;
            await request(tx.objectStore('clips').put(same));
            recovered = true;
          }
          if (!(await request(tx.objectStore('media').get(same.id)))) {
            await request(tx.objectStore('media').put(file.slice(0, file.size, same.type), same.id));
            recovered = true;
          }
          if (recovered) restored++;
          continue;
        }
        const type =
          file.type ||
          ({
            mp4: 'video/mp4',
            m4v: 'video/mp4',
            mov: 'video/quicktime',
            webm: 'video/webm',
            ogv: 'video/ogg',
            ogg: 'video/ogg',
          }[file.name.split('.').at(-1)!.toLowerCase()] ??
            'application/octet-stream');
        const clip: VideoClip = {
          id: crypto.randomUUID(),
          collectionId: id,
          title: videoTitle(file.name),
          filename: file.name,
          source,
          size: file.size,
          modified: file.lastModified,
          type,
          order: order++,
          hidden: false,
        };
        await request(tx.objectStore('clips').add(clip));
        await request(tx.objectStore('media').add(file.slice(0, file.size, type), clip.id));
        existing.push(clip);
        added++;
      }
      return { added, restored, skipped: files.length - added - restored };
    });
  }
  async function updateClip(
    dataset: Dataset,
    collectionId: string,
    id: string,
    change: { title?: string; hidden?: boolean },
  ) {
    if (change.title !== undefined) change = { ...change, title: title(change.title) };
    return transaction(['collections', 'clips'], 'readwrite', async (tx) => {
      await collection(tx, dataset, collectionId);
      const clip = await request<VideoClip | undefined>(tx.objectStore('clips').get(id));
      if (!clip || clip.collectionId !== collectionId) throw new Error('Видео не найдено.');
      await request(tx.objectStore('clips').put({ ...clip, ...change }));
    });
  }
  async function addYouTube(dataset: Dataset, id: string, url: string, name: string) {
    const youtubeId = youtubeIdFromUrl(url),
      nameText = title(name);
    return transaction(['collections', 'clips'], 'readwrite', async (tx) => {
      await collection(tx, dataset, id);
      const clips = await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(id));
      const existing = clips.find((c) => c.youtubeId === youtubeId);
      const order = Math.max(-1, ...clips.map((c) => c.order)) + 1;
      if (existing) {
        // Re-adding puts it at the end, retaining its title, ID and daily marks.
        const value = { ...existing, hidden: false, order };
        await request(tx.objectStore('clips').put(value));
        return value;
      }
      const clip: VideoClip = {
        id: crypto.randomUUID(),
        collectionId: id,
        title: nameText,
        filename: '',
        source: `https://www.youtube.com/watch?v=${youtubeId}`,
        size: 0,
        modified: 0,
        type: 'youtube',
        order,
        hidden: false,
        youtubeId,
      };
      await request(tx.objectStore('clips').add(clip));
      return clip;
    });
  }
  async function saveExercise(dataset: Dataset, collectionId: string, input: ExerciseInput, id?: string) {
    const { title: name, ...exercise } = exerciseInput(input);
    return transaction(['collections', 'clips'], 'readwrite', async (tx) => {
      await collection(tx, dataset, collectionId);
      const clips = await request<VideoClip[]>(
        tx.objectStore('clips').index('collection').getAll(collectionId),
      );
      const current = id
        ? clips.find((c) => c.id === id && c.exercise)
        : clips.find(
            (c) =>
              c.exercise &&
              c.title === name &&
              c.exercise.repetitions === exercise.repetitions &&
              c.exercise.instructions === exercise.instructions &&
              c.exercise.sourceUrl === exercise.sourceUrl,
          );
      if (id && !current) throw new Error('Упражнение не найдено. Обновите список.');
      if (current) {
        const value = { ...current, title: name, exercise, source: exercise.sourceUrl ?? '', hidden: false };
        await request(tx.objectStore('clips').put(value));
        return value;
      }
      const clip: VideoClip = {
        id: crypto.randomUUID(),
        collectionId,
        title: name,
        exercise,
        filename: '',
        source: exercise.sourceUrl ?? '',
        size: 0,
        modified: 0,
        type: 'exercise',
        order: Math.max(-1, ...clips.map((c) => c.order)) + 1,
        hidden: false,
      };
      await request(tx.objectStore('clips').add(clip));
      return clip;
    });
  }
  async function move(dataset: Dataset, collectionId: string, id: string, direction: -1 | 1) {
    return transaction(['collections', 'clips'], 'readwrite', async (tx) => {
      await collection(tx, dataset, collectionId);
      const clips = (
        await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(collectionId))
      )
        .filter((c) => !c.hidden)
        .sort((a, b) => a.order - b.order);
      const index = clips.findIndex((c) => c.id === id),
        other = clips[index + direction];
      if (index < 0 || !other) return;
      [clips[index].order, other.order] = [other.order, clips[index].order];
      await Promise.all([
        request(tx.objectStore('clips').put(clips[index])),
        request(tx.objectStore('clips').put(other)),
      ]);
    });
  }
  async function mark(
    dataset: Dataset,
    collectionId: string,
    videoId: string,
    date: DateKey,
    completed: boolean,
  ) {
    if (!validDate(date)) throw new Error('Выберите действительную дату.');
    return transaction(['collections', 'clips', 'marks'], 'readwrite', async (tx) => {
      await collection(tx, dataset, collectionId);
      const clip = await request<VideoClip | undefined>(tx.objectStore('clips').get(videoId));
      if (!clip || clip.collectionId !== collectionId || clip.hidden)
        throw new Error('Видео не найдено в подборке.');
      const id = `${videoId}@${date}`;
      if (completed)
        await request(
          tx
            .objectStore('marks')
            .put({ id, collectionId, videoId, date, completedAt: now().toISOString() } satisfies VideoMark),
        );
      else await request(tx.objectStore('marks').delete(id));
    });
  }
  async function media(dataset: Dataset, collectionId: string, videoId: string): Promise<Blob> {
    return transaction(['collections', 'clips', 'media'], 'readonly', async (tx) => {
      await collection(tx, dataset, collectionId);
      const clip = await request<VideoClip | undefined>(tx.objectStore('clips').get(videoId));
      if (!clip || clip.collectionId !== collectionId) throw new Error('Видео не найдено.');
      const blob = await request<Blob | undefined>(tx.objectStore('media').get(videoId));
      if (!blob) throw new Error('Файл видео недоступен. Добавьте исходный файл ещё раз.');
      return blob;
    });
  }

  /** Metadata, all dates' marks and Blobs come from one consistent IDB snapshot. */
  async function snapshot(dataset: Dataset): Promise<WorkoutSnapshot> {
    return transaction(['collections', 'clips', 'marks', 'media'], 'readonly', async (tx) => {
      const collections = await request<VideoCollection[]>(
        tx.objectStore('collections').index('dataset').getAll(dataset),
      );
      const collectionIds = new Set(collections.map((item) => item.id));
      const clips = (
        await Promise.all(
          collections.map((item) =>
            request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(item.id)),
          ),
        )
      )
        .flat()
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const marks = (await request<VideoMark[]>(tx.objectStore('marks').getAll())).filter((item) =>
        collectionIds.has(item.collectionId),
      );
      const library = parseWorkoutLibrary({ collections, clips, marks }, dataset);
      const blobs = new Map<string, Blob>();
      for (const clip of clips) {
        if (clip.youtubeId || clip.exercise) continue;
        const blob = await request<Blob | undefined>(tx.objectStore('media').get(clip.id));
        if (!blob || blob.size !== clip.size)
          throw new Error(`Файл «${clip.title}» недоступен. Добавьте исходный файл ещё раз перед экспортом.`);
        blobs.set(clip.id, blob);
      }
      return { library, media: blobs };
    });
  }

  /** Add missing records in one transaction. Existing edits and media win. */
  async function restore(dataset: Dataset, incoming: WorkoutSnapshot) {
    const library = parseWorkoutLibrary(incoming.library, dataset);
    const fileClips = library.clips.filter((clip) => !clip.youtubeId && !clip.exercise);
    if (!(incoming.media instanceof Map) || incoming.media.size !== fileClips.length)
      throw new Error('В архиве не хватает видеофайлов.');
    for (const clip of fileClips) {
      const blob = incoming.media.get(clip.id);
      if (!(blob instanceof Blob) || blob.size !== clip.size)
        throw new Error(`В архиве повреждён файл «${clip.title}».`);
    }
    return transaction(['collections', 'clips', 'marks', 'media'], 'readwrite', async (tx) => {
      const collectionStore = tx.objectStore('collections'),
        clipStore = tx.objectStore('clips');
      const existingCollections = await request<VideoCollection[]>(collectionStore.getAll());
      const existingClips = await request<VideoClip[]>(clipStore.getAll());
      const collectionMap = new Map<string, string>(),
        clipMap = new Map<string, string>();
      const linked = new Set(
        existingCollections
          .filter((item) => item.dataset === dataset)
          .map((item) => item.activityId)
          .filter(Boolean),
      );
      const result = { collections: 0, clips: 0, marks: 0, media: 0, unlinked: 0 };
      const newCollections = new Set<string>();
      for (const item of library.collections) {
        const existing = existingCollections.find((current) => current.id === item.id);
        const target = existing && existing.dataset !== dataset ? crypto.randomUUID() : item.id;
        collectionMap.set(item.id, target);
        if (existing?.dataset === dataset) continue;
        const activityId = item.activityId && !linked.has(item.activityId) ? item.activityId : undefined;
        if (item.activityId && !activityId) result.unlinked++;
        if (activityId) linked.add(activityId);
        const value = { ...item, id: target, activityId };
        await request(collectionStore.add(value));
        existingCollections.push(value);
        newCollections.add(target);
        result.collections++;
      }
      const nextOrder = new Map<string, number>();
      for (const clip of existingClips)
        nextOrder.set(clip.collectionId, Math.max(nextOrder.get(clip.collectionId) ?? 0, clip.order + 1));
      for (const clip of [...library.clips].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
        const collectionId = collectionMap.get(clip.collectionId)!;
        const existing = existingClips.find((current) => current.id === clip.id);
        const same = existing?.collectionId === collectionId;
        const target = existing && !same ? crypto.randomUUID() : clip.id;
        clipMap.set(clip.id, target);
        if (!same) {
          const order = newCollections.has(collectionId) ? clip.order : (nextOrder.get(collectionId) ?? 0);
          const value = { ...clip, id: target, collectionId, order };
          await request(clipStore.add(value));
          existingClips.push(value);
          nextOrder.set(collectionId, Math.max(nextOrder.get(collectionId) ?? 0, order + 1));
          result.clips++;
        }
        const blob = incoming.media.get(clip.id);
        // An old archive cannot turn an edited text/YouTube step back into a file.
        if (
          blob &&
          (!same || (!existing.exercise && !existing.youtubeId && existing.size === blob.size)) &&
          !(await request(tx.objectStore('media').get(target)))
        ) {
          await request(tx.objectStore('media').add(blob, target));
          result.media++;
        }
      }
      for (const mark of library.marks) {
        const videoId = clipMap.get(mark.videoId)!,
          key = `${videoId}@${mark.date}`;
        if (await request(tx.objectStore('marks').get(key))) continue;
        await request(
          tx
            .objectStore('marks')
            .add({ ...mark, id: key, videoId, collectionId: collectionMap.get(mark.collectionId)! }),
        );
        result.marks++;
      }
      return result;
    });
  }
  return {
    list,
    getCollections,
    create,
    updateCollection,
    addFiles,
    addYouTube,
    saveExercise,
    updateClip,
    move,
    mark,
    media,
    snapshot,
    restore,
  };
}
