import { createVideoStore } from './video-store';
import { createWorkoutBootstrap } from './local-workouts';
import type { Dataset } from './domain';

export const videoStore = createVideoStore({ name: `raspisulik:videos:${import.meta.env.BASE_URL}` });

export async function withWorkoutLock<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.locks)
    return navigator.locks.request(`raspisulik:video-writes:${import.meta.env.BASE_URL}`, operation);
  return operation();
}

const bootstrap = createWorkoutBootstrap({
  hasCollections: async () => (await videoStore.getCollections('personal')).length > 0,
  load: async () => {
    const response = await fetch('/api/workout-archive', { cache: 'no-store' });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error('Не удалось открыть готовые тренировки. Обновите страницу.');
    const { readWorkoutArchive } = await import('./workout-archive');
    return readWorkoutArchive(await response.blob());
  },
  restore: (snapshot) => videoStore.restore('personal', snapshot),
  exclusive: withWorkoutLock,
});

export async function ensureLocalWorkouts(dataset: Dataset): Promise<void> {
  if (import.meta.env.VITE_STORAGE_MODE !== 'browser' && dataset === 'personal') await bootstrap();
}
