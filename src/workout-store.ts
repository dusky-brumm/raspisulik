import { createVideoStore } from './video-store';

export const videoStore = createVideoStore({ name: `raspisulik:videos:${import.meta.env.BASE_URL}` });

export async function withWorkoutLock<T>(operation: () => Promise<T>): Promise<T> {
  if (navigator.locks)
    return navigator.locks.request(`raspisulik:video-writes:${import.meta.env.BASE_URL}`, operation);
  return operation();
}
