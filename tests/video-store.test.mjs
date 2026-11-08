import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createVideoStore, isVideoFile, videoProgress, youtubeIdFromUrl } from '../src/video-store.ts';

function fixture() {
  const options = { name: crypto.randomUUID(), factory: new IDBFactory(), now: () => new Date('2026-11-08T08:00:00Z') };
  return { store: createVideoStore(options), options };
}
const file = (name, body = 'test video') => new File([body], name, { type: 'video/webm', lastModified: 123 });

test('video blobs, renamed titles and per-day marks survive reopening without mixing datasets', async () => {
  const { store, options } = fixture();
  const a = await store.create('personal', 'Зарядка', 'morning');
  await store.addFiles('personal', a.id, [file('01_Разминка.webm')]);
  const clip = (await store.list('personal', '2026-11-08')).clips[0];
  await store.mark('personal', a.id, clip.id, '2026-11-08', true);
  await store.updateClip('personal', a.id, clip.id, { title: 'Моя разминка' });
  const reopened = createVideoStore(options);
  const state = await reopened.list('personal', '2026-11-08');
  assert.equal(state.clips[0].title, 'Моя разминка');
  assert.equal(state.clips[0].id, clip.id);
  assert.equal(videoProgress(state.clips, state.marks, a.id, '2026-11-08').allDone, true);
  assert.equal(await (await reopened.media('personal', a.id, clip.id)).text(), 'test video');
  assert.equal((await reopened.list('personal', '2026-11-09')).marks.length, 0);
  assert.deepEqual(await reopened.list('demo', '2026-11-08'), { collections: [], clips: [], marks: [] });
  await assert.rejects(reopened.media('demo', a.id, clip.id));
});

test('folder import keeps same-named files in distinct subfolders, sorts naturally and ignores non-video', async () => {
  const { store } = fixture();
  const a = await store.create('personal', 'Папка');
  const ten = file('10.webm'), two = file('2.webm');
  const other = file('2.webm');
  Object.defineProperty(two, 'webkitRelativePath', { value: 'Утро/2.webm' });
  Object.defineProperty(other, 'webkitRelativePath', { value: 'Вечер/2.webm' });
  const result = await store.addFiles('personal', a.id, [ten, two, other, new File(['ignore'], 'notes.txt')]);
  assert.deepEqual(result, { added: 3, restored: 0, skipped: 1 });
  const state = await store.list('personal', '2026-11-08');
  assert.equal(new Set(state.clips.map(c => c.source)).size, 3);
  const order = await store.create('personal', 'Порядок');
  await store.addFiles('personal', order.id, [file('10.webm'), file('2.webm'), file('1.webm')]);
  assert.deepEqual((await store.list('personal', '2026-11-08')).clips.filter(c => c.collectionId === order.id).map(c => c.title), ['1', '2', '10']);
});

test('reimport deduplicates and restores hidden clips with original IDs and marks', async () => {
  const { store } = fixture();
  const a = await store.create('personal', 'Зарядка');
  await store.addFiles('personal', a.id, [file('warmup.webm')]);
  const clip = (await store.list('personal', '2026-11-08')).clips[0];
  await store.mark('personal', a.id, clip.id, '2026-11-08', true);
  await store.updateClip('personal', a.id, clip.id, { hidden: true });
  assert.deepEqual(await store.addFiles('personal', a.id, [file('warmup.webm')]), { added: 0, restored: 1, skipped: 0 });
  assert.deepEqual(await store.addFiles('personal', a.id, [file('warmup.webm')]), { added: 0, restored: 0, skipped: 1 });
  const state = await store.list('personal', '2026-11-08');
  assert.equal(state.clips.length, 1);
  assert.equal(state.clips[0].id, clip.id);
  assert.equal(videoProgress(state.clips, state.marks, a.id, '2026-11-08').allDone, true);
});

test('failed blob import rolls back the entire batch and preserves existing media and marks', async () => {
  const { store } = fixture();
  const a = await store.create('personal', 'Зарядка');
  await store.addFiles('personal', a.id, [file('old.webm')]);
  const original = await store.list('personal', '2026-11-08');
  await store.mark('personal', a.id, original.clips[0].id, '2026-11-08', true);
  const before = await store.list('personal', '2026-11-08');
  const broken = file('z-broken.webm');
  broken.slice = () => { throw new DOMException('Disk full', 'QuotaExceededError'); };
  await assert.rejects(store.addFiles('personal', a.id, [file('new.webm'), broken]), { name: 'QuotaExceededError' });
  assert.deepEqual(await store.list('personal', '2026-11-08'), before);
  assert.equal(await (await store.media('personal', a.id, original.clips[0].id)).text(), 'test video');
});

test('concurrent imports and marks from two tabs retain all writes', async () => {
  const { store, options } = fixture(), other = createVideoStore(options);
  const a = await store.create('personal', 'Зарядка');
  await Promise.all([store.addFiles('personal', a.id, [file('one.webm')]), other.addFiles('personal', a.id, [file('two.webm')])]);
  const clips = (await store.list('personal', '2026-11-08')).clips;
  await Promise.all(clips.map((c, i) => (i ? other : store).mark('personal', a.id, c.id, '2026-11-08', true)));
  const state = await other.list('personal', '2026-11-08');
  assert.equal(state.clips.length, 2);
  assert.equal(state.marks.length, 2);
  await other.mark('personal', a.id, clips[0].id, '2026-11-08', false);
  assert.equal((await store.list('personal', '2026-11-08')).marks.length, 1);
});

test('one task has one collection; ordering and renaming preserve daily progress', async () => {
  const { store } = fixture();
  const a = await store.create('personal', 'Утро', 'morning');
  await assert.rejects(store.create('personal', 'Дубль', 'morning'));
  const b = await store.create('personal', 'Вечер');
  await assert.rejects(store.updateCollection('personal', b.id, 'Дубль', 'morning'));
  await store.addFiles('personal', a.id, [file('1.webm'), file('2.webm')]);
  const clips = (await store.list('personal', '2026-11-08')).clips;
  await store.mark('personal', a.id, clips[0].id, '2026-11-08', true);
  await store.move('personal', a.id, clips[0].id, 1);
  await store.updateCollection('personal', a.id, 'Зарядка', 'morning');
  const state = await store.list('personal', '2026-11-08');
  assert.equal(state.clips[1].id, clips[0].id);
  assert.deepEqual(videoProgress(state.clips, state.marks, a.id, '2026-11-08'), { completed: 1, total: 2, allDone: false });
  assert.equal(videoProgress([], [], a.id, '2026-11-08').allDone, false);
  await assert.rejects(store.mark('personal', a.id, clips[0].id, '2026-02-30', true));
  await assert.rejects(store.mark('personal', b.id, clips[0].id, '2026-11-08', true));
});

test('YouTube links append after files and preserve IDs and marks on re-add', async () => {
  const { store, options } = fixture();
  const a = await store.create('personal', 'Зарядка');
  await store.addFiles('personal', a.id, [file('Начало.webm')]);
  const clip = await store.addYouTube('personal', a.id, 'https://www.youtube.com/watch?v=VlOH_hq4aec&si=ignored', 'Кор и пресс');
  await store.mark('personal', a.id, clip.id, '2026-11-08', true);
  await store.addFiles('personal', a.id, [file('Середина.webm')]);
  const again = await store.addYouTube('personal', a.id, 'https://youtu.be/VlOH_hq4aec', 'Другое имя');
  assert.equal(again.id, clip.id);
  const state = await createVideoStore(options).list('personal', '2026-11-08');
  assert.equal(state.clips.length, 3);
  assert.equal(state.clips.at(-1).id, clip.id);
  assert.equal(state.clips.at(-1).title, 'Кор и пресс');
  assert.equal(state.clips.at(-1).source, 'https://www.youtube.com/watch?v=VlOH_hq4aec');
  assert.equal(state.marks.length, 1);
  assert.equal((await store.list('personal', '2026-11-09')).marks.length, 0);
  await store.updateClip('personal', a.id, clip.id, { hidden: true });
  await store.addYouTube('personal', a.id, 'https://www.youtube.com/shorts/VlOH_hq4aec', 'Новое имя');
  assert.equal((await store.list('personal', '2026-11-08')).clips.at(-1).hidden, false);
});

test('YouTube URLs accept official variants and reject unrelated or executable links', () => {
  for (const url of ['https://youtube.com/watch?v=VlOH_hq4aec', 'https://youtu.be/VlOH_hq4aec?t=5', 'https://m.youtube.com/watch?v=VlOH_hq4aec', 'https://www.youtube.com/embed/VlOH_hq4aec', 'https://www.youtube.com/live/VlOH_hq4aec']) assert.equal(youtubeIdFromUrl(url), 'VlOH_hq4aec');
  for (const url of ['javascript:alert(1)', 'http://youtube.com/watch?v=VlOH_hq4aec', 'https://youtube.com.evil.test/watch?v=VlOH_hq4aec', 'https://youtube.com@evil.test/watch?v=VlOH_hq4aec', 'https://youtube.com:444/watch?v=VlOH_hq4aec', 'https://youtube.com/watch?v=bad', 'https://example.com/VlOH_hq4aec']) assert.throws(() => youtubeIdFromUrl(url));
});

test('empty files are rejected and absent MIME types can fall back to video extensions', () => {
  assert.equal(isVideoFile(new File(['abc'], 'video.MP4')), true);
  assert.equal(isVideoFile(new File([], 'empty.mp4')), false);
  assert.equal(isVideoFile(new File(['abc'], 'notes.txt')), false);
});

test('switching from files to folders does not duplicate an existing clip or lose distinct subfolders', async () => {
  const { store } = fixture();
  const a = await store.create('personal', 'Зарядка');
  await store.addFiles('personal', a.id, [file('warmup.webm')]);
  const original = (await store.list('personal', '2026-11-08')).clips[0];
  const inFolder = file('warmup.webm'), otherFolder = file('warmup.webm');
  Object.defineProperty(inFolder, 'webkitRelativePath', { value: 'Утро/warmup.webm' });
  Object.defineProperty(otherFolder, 'webkitRelativePath', { value: 'Вечер/warmup.webm' });
  await store.addFiles('personal', a.id, [inFolder, otherFolder]);
  const clips = (await store.list('personal', '2026-11-08')).clips;
  assert.equal(clips.length, 2);
  assert.ok(clips.some(c => c.id === original.id));
  assert.equal(new Set(clips.map(c => c.source)).size, 2);
  assert.equal((await store.addFiles('personal', a.id, [file('warmup.webm')])).added, 0);
});

test('reimport repairs a missing blob while keeping its title, ID and history', async () => {
  const { store, options } = fixture();
  const a = await store.create('personal', 'Зарядка');
  await store.addFiles('personal', a.id, [file('warmup.webm')]);
  const clip = (await store.list('personal', '2026-11-08')).clips[0];
  await store.updateClip('personal', a.id, clip.id, { title: 'Моя разминка' });
  await store.mark('personal', a.id, clip.id, '2026-11-08', true);
  const opened = options.factory.open(options.name, 1);
  const db = await new Promise((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
  const tx = db.transaction(['media'], 'readwrite');
  tx.objectStore('media').delete(clip.id);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  db.close();
  await assert.rejects(store.media('personal', a.id, clip.id));
  assert.equal((await store.addFiles('personal', a.id, [file('warmup.webm')])).restored, 1);
  const state = await store.list('personal', '2026-11-08');
  assert.equal(state.clips[0].title, 'Моя разминка');
  assert.equal(state.clips[0].id, clip.id);
  assert.equal(state.marks.length, 1);
  assert.equal(await (await store.media('personal', a.id, clip.id)).text(), 'test video');
});
