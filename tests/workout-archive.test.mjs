import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { strToU8, zipSync } from 'fflate';
import { createVideoStore } from '../src/video-store.ts';
import { exportWorkoutArchive, readWorkoutArchive } from '../src/workout-archive.ts';
import { parseWorkoutLibrary } from '../src/workout-validation.ts';

const makeStore = () =>
  createVideoStore({
    name: crypto.randomUUID(),
    factory: new IDBFactory(),
    now: () => new Date('2026-11-09T01:00:00.000Z'),
  });
async function fixture() {
  const store = makeStore(),
    collection = await store.create('personal', 'Серия шагов', 'morning');
  await store.addFiles('personal', collection.id, [
    new File(['original video bytes'], '01_Фрагмент.webm', { type: 'video/webm', lastModified: 100 }),
  ]);
  const clip = (await store.list('personal', '2026-11-09')).clips[0];
  const exercise = await store.saveExercise('personal', collection.id, {
    title: 'Текстовый шаг',
    repetitions: 'Повторить 2 раза',
    instructions: 'Тестовая инструкция для переноса',
    sourceUrl: 'https://example.org/exercise/',
  });
  await store.addYouTube('personal', collection.id, 'https://youtu.be/abcdefghijk', 'Ссылка на видео');
  await store.mark('personal', collection.id, clip.id, '2026-11-08', true);
  await store.mark('personal', collection.id, exercise.id, '2026-11-09', true);
  await store.updateClip('personal', collection.id, clip.id, { hidden: true });
  return { store, collection, clip, exercise };
}

test('portable ZIP retains text, YouTube, hidden files, every date and original IDs', async () => {
  const { store, collection, clip } = await fixture();
  const snapshot = await store.snapshot('personal');
  const archive = await exportWorkoutArchive(snapshot);
  const decoded = await readWorkoutArchive(archive);
  assert.deepEqual(decoded.library, snapshot.library);
  assert.equal(await decoded.media.get(clip.id).text(), 'original video bytes');
  const target = makeStore();
  assert.deepEqual(await target.restore('personal', decoded), {
    collections: 1,
    clips: 3,
    marks: 2,
    media: 1,
    unlinked: 0,
  });
  assert.deepEqual((await target.snapshot('personal')).library, snapshot.library);
  assert.equal(await (await target.media('personal', collection.id, clip.id)).text(), 'original video bytes');
  assert.deepEqual(await target.restore('personal', decoded), {
    collections: 0,
    clips: 0,
    marks: 0,
    media: 0,
    unlinked: 0,
  });
  assert.deepEqual((await target.snapshot('personal')).library, snapshot.library);
});

test('restoring an older archive preserves current edits, ordering and completion timestamps', async () => {
  const { store, collection, clip, exercise } = await fixture();
  const snapshot = await store.snapshot('personal');
  await store.updateCollection('personal', collection.id, 'Новое название', 'morning');
  await store.updateClip('personal', collection.id, clip.id, { title: 'Мой фрагмент' });
  await store.move('personal', collection.id, exercise.id, 1);
  const before = await store.snapshot('personal');
  await store.restore('personal', snapshot);
  assert.deepEqual((await store.snapshot('personal')).library, before.library);
});

test('ID collisions in another dataset are remapped without overwriting its library or blobs', async () => {
  const { store: source, clip } = await fixture();
  const snapshot = await source.snapshot('personal');
  const target = makeStore(),
    demo = await target.create('demo', 'Демонстрационная подборка');
  await target.addFiles('demo', demo.id, [new File(['demo video'], 'demo.webm', { type: 'video/webm' })]);
  const demoClip = (await target.list('demo', '2026-11-09')).clips[0];
  const demoBefore = await target.snapshot('demo');
  const incoming = structuredClone(snapshot.library);
  const oldCollectionId = incoming.collections[0].id;
  incoming.collections[0].id = demo.id;
  for (const item of incoming.clips) {
    if (item.collectionId === oldCollectionId) item.collectionId = demo.id;
    if (item.id === clip.id) item.id = demoClip.id;
  }
  for (const item of incoming.marks) {
    item.collectionId = demo.id;
    if (item.videoId === clip.id) {
      item.videoId = demoClip.id;
      item.id = `${demoClip.id}@${item.date}`;
    }
  }
  await target.restore('personal', {
    library: incoming,
    media: new Map([[demoClip.id, snapshot.media.get(clip.id)]]),
  });
  assert.deepEqual((await target.snapshot('demo')).library, demoBefore.library);
  assert.equal(await (await target.media('demo', demo.id, demoClip.id)).text(), 'demo video');
  const restored = await target.snapshot('personal');
  assert.notEqual(restored.library.collections[0].id, demo.id);
  const restoredFile = restored.library.clips.find((item) => !item.exercise && !item.youtubeId);
  assert.notEqual(restoredFile.id, demoClip.id);
  assert.equal(await restored.media.get(restoredFile.id).text(), 'original video bytes');
});

test('restoring a second collection cannot steal an existing activity link', async () => {
  const { store: source } = await fixture(),
    target = makeStore();
  const current = await target.create('personal', 'Моя зарядка', 'morning');
  const result = await target.restore('personal', await source.snapshot('personal'));
  assert.equal(result.unlinked, 1);
  const collections = (await target.list('personal', '2026-11-09')).collections;
  assert.equal(collections.find((item) => item.id === current.id).activityId, 'morning');
  assert.equal(collections.filter((item) => item.activityId === 'morning').length, 1);
});

test('a quota failure rolls back the entire restore transaction', async () => {
  const { store: source } = await fixture(),
    target = makeStore();
  const original = await target.create('personal', 'Уже сохранено');
  await target.saveExercise('personal', original.id, {
    title: 'Старый шаг',
    repetitions: 'Один раз',
    instructions: 'Сохранить',
  });
  const before = await target.snapshot('personal'),
    incoming = await source.snapshot('personal');
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'media') throw new DOMException('Full disk', 'QuotaExceededError');
    return originalAdd.apply(this, args);
  };
  try {
    await assert.rejects(target.restore('personal', incoming), { name: 'QuotaExceededError' });
  } finally {
    IDBObjectStore.prototype.add = originalAdd;
  }
  assert.deepEqual((await target.snapshot('personal')).library, before.library);
});

test('truncated or corrupted video bytes are rejected before restoring any data', async () => {
  const { store } = await fixture(),
    archive = await exportWorkoutArchive(await store.snapshot('personal'));
  await assert.rejects(readWorkoutArchive(archive.slice(0, archive.size - 1)), /повреждён|исходный/);
  const bytes = Buffer.from(await archive.arrayBuffer());
  const index = bytes.indexOf('original video bytes');
  assert.ok(index > 0);
  bytes[index] ^= 1;
  await assert.rejects(readWorkoutArchive(new Blob([bytes])), /повреждён/);
  const metadataBytes = Buffer.from(await archive.arrayBuffer());
  const nameIndex = metadataBytes.indexOf('morning');
  assert.ok(nameIndex > 0);
  metadataBytes[nameIndex] ^= 1;
  await assert.rejects(readWorkoutArchive(new Blob([metadataBytes])), /повреждено/);
});

test('unknown ZIP paths, compressed entries and incomplete manifests are rejected', async () => {
  for (const files of [
    { '../video.webm': strToU8('unexpected') },
    { 'manifest.json': strToU8('{}') },
    { 'manifest.json': strToU8('not json') },
  ])
    await assert.rejects(readWorkoutArchive(new Blob([zipSync(files, { level: 0 })])));
  await assert.rejects(
    readWorkoutArchive(
      new Blob([zipSync({ 'manifest.json': strToU8('compressed '.repeat(100)) }, { level: 6 })]),
    ),
  );
});

test('manifest validation rejects executable sources, duplicate marks and orphan steps', async () => {
  const { store } = await fixture(),
    snapshot = await store.snapshot('personal');
  for (const mutate of [
    (library) => {
      library.clips.find((item) => item.exercise).exercise.sourceUrl = 'javascript:alert(1)';
    },
    (library) => {
      library.clips[0].collectionId = 'missing';
    },
    (library) => {
      library.marks.push(library.marks[0]);
    },
    (library) => {
      library.collections[0].dataset = 'demo';
    },
    (library) => {
      library.clips[0].size = 257 * 1024 * 1024;
    },
  ]) {
    const library = structuredClone(snapshot.library);
    mutate(library);
    assert.throws(() => parseWorkoutLibrary(library, 'personal'));
  }
});

test('an empty library still makes a valid portable ZIP and cancelled work stops cleanly', async () => {
  const empty = { library: { collections: [], clips: [], marks: [] }, media: new Map() };
  assert.deepEqual(await readWorkoutArchive(await exportWorkoutArchive(empty)), empty);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(exportWorkoutArchive(empty, { signal: abort.signal }), { name: 'AbortError' });
  await assert.rejects(readWorkoutArchive(new Blob(), { signal: abort.signal }), { name: 'AbortError' });
});
