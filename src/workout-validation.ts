import { validDate } from './domain.ts';
import type { Dataset } from './domain.ts';
import type { VideoClip, VideoCollection, VideoLibrary, VideoMark } from './video-store.ts';

export const MAX_WORKOUT_MEDIA_BYTES = 512 * 1024 * 1024;
export const MAX_WORKOUT_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_WORKOUT_MANIFEST_BYTES = 8 * 1024 * 1024;

function requireValue(condition: unknown, message = 'Архив тренировок повреждён.'): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function safeSource(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Copy only known fields, before opening a write transaction. */
export function parseWorkoutLibrary(value: unknown, dataset: Dataset): VideoLibrary {
  requireValue(object(value));
  requireValue(
    Array.isArray(value.collections) && value.collections.length <= 200,
    'В архиве слишком много подборок (максимум 200).',
  );
  requireValue(
    Array.isArray(value.clips) && value.clips.length <= 5000,
    'В архиве слишком много шагов (максимум 5000).',
  );
  requireValue(
    Array.isArray(value.marks) && value.marks.length <= 100_000,
    'В архиве слишком много отметок (максимум 100 000).',
  );
  const collections: VideoCollection[] = [],
    clips: VideoClip[] = [],
    marks: VideoMark[] = [];
  const collectionIds = new Set<string>(),
    clipIds = new Set<string>(),
    markIds = new Set<string>(),
    links = new Set<string>();
  let mediaSize = 0;
  for (const item of value.collections) {
    requireValue(object(item) && id(item.id) && !collectionIds.has(item.id));
    requireValue(item.dataset === dataset && text(item.title, 180) && timestamp(item.createdAt));
    requireValue(item.activityId === undefined || (id(item.activityId) && !links.has(item.activityId)));
    collectionIds.add(item.id);
    if (item.activityId) links.add(item.activityId);
    collections.push({
      id: item.id,
      dataset,
      title: item.title,
      createdAt: item.createdAt,
      ...(item.activityId ? { activityId: item.activityId } : {}),
    });
  }
  for (const item of value.clips) {
    requireValue(object(item) && id(item.id) && !clipIds.has(item.id));
    requireValue(typeof item.collectionId === 'string' && collectionIds.has(item.collectionId));
    requireValue(text(item.title, 180) && text(item.filename, 512, true) && text(item.source, 4096, true));
    requireValue(
      typeof item.size === 'number' &&
        Number.isSafeInteger(item.size) &&
        item.size >= 0 &&
        item.size <= MAX_WORKOUT_FILE_BYTES,
      'Один видеофайл в архиве должен занимать не больше 256 МБ.',
    );
    requireValue(
      typeof item.modified === 'number' && Number.isSafeInteger(item.modified) && item.modified >= 0,
    );
    requireValue(typeof item.order === 'number' && Number.isSafeInteger(item.order) && item.order >= 0);
    requireValue(typeof item.hidden === 'boolean' && text(item.type, 160));
    let clip: VideoClip = {
      id: item.id,
      collectionId: item.collectionId,
      title: item.title,
      filename: item.filename,
      source: item.source,
      size: item.size,
      modified: item.modified,
      type: item.type,
      order: item.order,
      hidden: item.hidden,
    };
    if (item.type === 'exercise') {
      requireValue(item.size === 0 && item.youtubeId === undefined && object(item.exercise));
      const exercise = item.exercise;
      requireValue(text(exercise.repetitions, 180) && text(exercise.instructions, 4000));
      requireValue(exercise.sourceUrl === undefined || safeSource(exercise.sourceUrl));
      clip = {
        ...clip,
        source: exercise.sourceUrl ?? '',
        exercise: {
          repetitions: exercise.repetitions,
          instructions: exercise.instructions,
          ...(exercise.sourceUrl ? { sourceUrl: exercise.sourceUrl } : {}),
        },
      };
    } else if (item.type === 'youtube') {
      requireValue(
        item.size === 0 &&
          item.exercise === undefined &&
          typeof item.youtubeId === 'string' &&
          /^[a-zA-Z0-9_-]{11}$/.test(item.youtubeId),
      );
      clip = {
        ...clip,
        youtubeId: item.youtubeId,
        source: `https://www.youtube.com/watch?v=${item.youtubeId}`,
      };
    } else {
      requireValue(item.size > 0 && item.exercise === undefined && item.youtubeId === undefined);
      requireValue(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(item.type));
      mediaSize += item.size;
      requireValue(
        mediaSize <= MAX_WORKOUT_MEDIA_BYTES,
        'Видео в одном архиве должны занимать не больше 512 МБ.',
      );
    }
    clipIds.add(item.id);
    clips.push(clip);
  }
  const clipCollections = new Map(clips.map((clip) => [clip.id, clip.collectionId]));
  for (const item of value.marks) {
    requireValue(object(item) && typeof item.videoId === 'string' && clipCollections.has(item.videoId));
    requireValue(
      typeof item.collectionId === 'string' &&
        item.collectionId === clipCollections.get(item.videoId) &&
        validDate(item.date) &&
        timestamp(item.completedAt),
    );
    const key = `${item.videoId}@${item.date}`;
    requireValue(item.id === key && !markIds.has(key));
    markIds.add(key);
    marks.push({
      id: key,
      collectionId: item.collectionId,
      videoId: item.videoId,
      date: item.date,
      completedAt: item.completedAt,
    });
  }
  return { collections, clips, marks };
}
