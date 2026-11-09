import type { WorkoutSnapshot } from './video-store.ts';

/** First-run setup only. Existing browser libraries are never replaced or repopulated. */
export function createWorkoutBootstrap(options: {
  hasCollections: () => Promise<boolean>;
  load: () => Promise<WorkoutSnapshot | null>;
  restore: (snapshot: WorkoutSnapshot) => Promise<unknown>;
  exclusive: (operation: () => Promise<void>) => Promise<void>;
}) {
  let pending: Promise<void> | undefined;
  return function ensure(): Promise<void> {
    if (!pending)
      pending = options
        .exclusive(async () => {
          if (await options.hasCollections()) return;
          const snapshot = await options.load();
          if (snapshot) await options.restore(snapshot);
        })
        .catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
    return pending;
  };
}
