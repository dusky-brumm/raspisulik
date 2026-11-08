import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../server/storage.mjs';

const base = { schemaVersion: 1, timezone: 'Asia/Qyzylorda', goals: [], activities: [{ id: 'read', title: 'Чтение', kind: 'habit', startDate: '2026-11-01', durationMinutes: 20, recurrence: { type: 'daily' } }] };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'raspisulik-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dataset of ['personal', 'demo']) {
    await mkdir(path.join(root, dataset));
    await writeFile(path.join(root, dataset, 'schedule.json'), JSON.stringify(base));
  }
  return { root, store: createStore(root) };
}
test('completion survives a new store instance and schedule edits without touching schedule', async t => {
  const { root, store } = await fixture(t);
  const file = path.join(root, 'personal/schedule.json');
  const original = await readFile(file, 'utf8');
  await store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true });
  assert.equal(await readFile(file, 'utf8'), original);
  const changed = structuredClone(base);
  changed.activities[0].title = 'Новое название';
  changed.activities[0].time = '21:30';
  await writeFile(file, JSON.stringify(changed));
  const reloaded = await createStore(root).load('personal');
  assert.equal(reloaded.schedule.activities[0].time, '21:30');
  assert.ok(reloaded.completions.completed['read@2026-11-08']);
  assert.equal(reloaded.completions.completed['read@2026-11-09'], undefined);
  assert.deepEqual((await store.load('demo')).completions.completed, {});
});
test('concurrent writes preserve all occurrence marks and explicit repeated writes are idempotent', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.setCompleted('personal', { activityId: 'read', date: `2026-11-${String(i + 1).padStart(2, '0')}`, completed: true })));
  assert.equal(Object.keys((await store.load('personal')).completions.completed).length, 20);
  await store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true });
  assert.equal(Object.keys((await store.load('personal')).completions.completed).length, 20);
  await store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: false });
  assert.equal(Object.keys((await store.load('personal')).completions.completed).length, 19);
});
test('corrupt completion or schedule data is never silently reset', async t => {
  const { root, store } = await fixture(t);
  const file = path.join(root, 'personal/completions.json');
  await writeFile(file, '{broken');
  await assert.rejects(store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true }));
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, completed: {} }));
  const scheduleFile = path.join(root, 'personal/schedule.json');
  await writeFile(scheduleFile, '{invalid');
  await assert.rejects(store.load('personal'));
  assert.equal(await readFile(scheduleFile, 'utf8'), '{invalid');
});
test('invalid requests do not poison the write queue or create marks', async t => {
  const { store } = await fixture(t);
  for (const input of [
    { activityId: 'missing', date: '2026-11-08', completed: true },
    { activityId: 'read', date: '2026-11-31', completed: true },
    { activityId: 'read', date: '2026-11-31', completed: false },
    { activityId: 'read', date: '2026-10-30', completed: true },
    { activityId: 'read', date: '2026-11-08', completed: 'yes' },
  ]) await assert.rejects(store.setCompleted('personal', input));
  await assert.rejects(store.load('../personal'));
  await store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true });
  assert.equal(Object.keys((await store.load('personal')).completions.completed).length, 1);
});

test('moving a task between group types and sections preserves its occurrence marks', async t => {
  const { root, store } = await fixture(t);
  await store.setCompleted('personal', { activityId: 'read', date: '2026-11-08', completed: true });
  const changed = structuredClone(base);
  changed.goals = [
    { id: 'learning', title: 'Обучение', description: '', color: 'lavender', type: 'goal' },
    { id: 'project', title: 'Личный проект', description: '', color: 'blue', type: 'project' },
  ];
  changed.activities[0].goalId = 'learning';
  changed.activities[0].section = 'Чтение';
  const file = path.join(root, 'personal/schedule.json');
  await writeFile(file, JSON.stringify(changed));
  const stamp = (await store.load('personal')).completions.completed['read@2026-11-08'];
  changed.activities[0].goalId = 'project';
  changed.activities[0].section = 'Подготовка';
  await writeFile(file, JSON.stringify(changed));
  const loaded = await createStore(root).load('personal');
  assert.equal(loaded.schedule.activities[0].section, 'Подготовка');
  assert.equal(loaded.completions.completed['read@2026-11-08'], stamp);
  assert.equal(Object.keys(loaded.completions.completed).length, 1);
});
