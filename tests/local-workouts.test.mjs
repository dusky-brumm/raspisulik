import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createVideoStore } from '../src/video-store.ts';
import { createWorkoutBootstrap } from '../src/local-workouts.ts';

const makeStore = () => createVideoStore({ name: crypto.randomUUID(), factory: new IDBFactory() });

test('first local open restores a prepared checklist, files and IDs once under concurrent loads', async () => {
  const source = makeStore(),
    target = makeStore();
  const collection = await source.create('personal', 'Разминка', 'warm-up');
  await source.addFiles('personal', collection.id, [
    new File(['fixture'], 'Движение.webm', { type: 'video/webm' }),
  ]);
  const snapshot = await source.snapshot('personal');
  let loads = 0;
  const ensure = createWorkoutBootstrap({
    hasCollections: async () => (await target.getCollections('personal')).length > 0,
    load: async () => {
      loads++;
      return snapshot;
    },
    restore: (value) => target.restore('personal', value),
    exclusive: (operation) => operation(),
  });
  await Promise.all([ensure(), ensure(), ensure()]);
  assert.equal(loads, 1);
  const clip = snapshot.library.clips[0];
  assert.equal((await target.getCollections('personal'))[0].id, collection.id);
  assert.equal(await (await target.media('personal', collection.id, clip.id)).text(), 'fixture');
  await target.mark('personal', collection.id, clip.id, '2026-11-09', true);
  await ensure();
  assert.equal((await target.list('personal', '2026-11-09')).marks.length, 1);
});

test('an existing library is left alone even when a prepared archive is available', async () => {
  let loaded = false;
  const ensure = createWorkoutBootstrap({
    hasCollections: async () => true,
    load: async () => {
      loaded = true;
      throw new Error('Must not load');
    },
    restore: async () => {
      throw new Error('Must not restore');
    },
    exclusive: (operation) => operation(),
  });
  await ensure();
  assert.equal(loaded, false);
});

test('a failed first load is retryable and never writes a partial checklist', async () => {
  let calls = 0,
    writes = 0;
  const ensure = createWorkoutBootstrap({
    hasCollections: async () => false,
    load: async () => {
      if (++calls === 1) throw new Error('Temporary failure');
      return null;
    },
    restore: async () => {
      writes++;
    },
    exclusive: (operation) => operation(),
  });
  await assert.rejects(ensure(), /Temporary failure/);
  await ensure();
  assert.equal(calls, 2);
  assert.equal(writes, 0);
});
