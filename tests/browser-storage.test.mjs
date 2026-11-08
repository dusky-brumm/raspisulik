import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserStore } from '../src/browser-storage.ts';

const schedule = {
  schemaVersion: 1, timezone: 'Asia/Qyzylorda', goals: [],
  challenge: { title: '30 дней', startDate: '2026-11-08', durationDays: 30 },
  activities: [{ id: 'read', title: 'Чтение', kind: 'habit', startDate: '2026-11-01', durationMinutes: 20, recurrence: { type: 'daily' } }],
};
function fixture() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const options = { storage, namespace: 'test:/raspisulik/', loadTemplate: async () => structuredClone(schedule), now: () => new Date('2026-11-08T12:00:00Z') };
  return { values, storage, options, store: createBrowserStore(options) };
}
test('browser marks survive reload, stay per-occurrence, and are separate from demo', async () => {
  const { store, options } = fixture();
  await store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true });
  const reload = createBrowserStore(options);
  assert.ok((await reload.load('personal')).completions.completed['read@2026-11-08']);
  assert.equal((await reload.load('personal')).completions.completed['read@2026-11-09'], undefined);
  assert.deepEqual((await reload.load('demo')).completions.completed, {});
});
test('browser date follows Qyzylorda midnight without rebuilding or recreating the store', async () => {
  const { options } = fixture();
  let instant = new Date('2026-11-08T18:59:59Z');
  const store = createBrowserStore({ ...options, now: () => instant });
  assert.equal((await store.load('personal')).today, '2026-11-08');
  instant = new Date('2026-11-08T19:00:00Z');
  assert.equal((await store.load('personal')).today, '2026-11-09');
});
test('concurrent mutations through one store preserve each date', async () => {
  const { store } = fixture();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.setCompleted('personal', { activityId: 'read', date: `2026-11-${String(i + 1).padStart(2, '0')}`, completed: true })));
  assert.equal(Object.keys((await store.load('personal')).completions.completed).length, 20);
});
test('shared exclusive lock protects simultaneous writes from separate tabs', async () => {
  const { options } = fixture();
  let lock = Promise.resolve();
  const exclusive = operation => { const next = lock.then(operation); lock = next.catch(() => {}); return next; };
  const a = createBrowserStore({ ...options, exclusive });
  const b = createBrowserStore({ ...options, exclusive });
  await Promise.all([
    a.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true }),
    b.setCompleted('personal', { activityId: 'read', date: '2026-11-09', completed: true }),
  ]);
  assert.equal(Object.keys((await a.load('personal')).completions.completed).length, 2);
});
test('importing schedule edits preserves marks and backup round trip restores both', async () => {
  const { store } = fixture();
  await store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true });
  const changed = structuredClone(schedule);
  changed.activities[0].title = 'Новое название';
  await store.importPersonal(JSON.stringify(changed));
  assert.equal((await store.load('personal')).schedule.activities[0].title, 'Новое название');
  assert.ok((await store.load('personal')).completions.completed['read@2026-11-08']);
  const exported = await store.exportPersonal();
  const other = fixture().store;
  await other.importPersonal(exported);
  assert.equal((await other.load('personal')).schedule.activities[0].title, 'Новое название');
  assert.ok((await other.load('personal')).completions.completed['read@2026-11-08']);
});
test('invalid imports and quota errors leave existing browser data intact', async () => {
  const { store, values, storage } = fixture();
  await store.importPersonal(JSON.stringify(schedule));
  const before = [...values];
  await assert.rejects(store.importPersonal('{invalid'));
  await assert.rejects(store.importPersonal(JSON.stringify({ ...schedule, timezone: 'UTC' })));
  assert.deepEqual([...values], before);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true }));
  assert.deepEqual([...values], before);
});
test('corrupt browser data is reported instead of silently discarded', async () => {
  const { store, values } = fixture();
  values.set('test:/raspisulik/:personal', '{broken');
  await assert.rejects(store.load('personal'));
  assert.equal(values.get('test:/raspisulik/:personal'), '{broken');
});
