import test from 'node:test';
import assert from 'node:assert/strict';
import { activityOnDate, agendaBlocks, daySegments, occurrences, validateSchedule } from '../src/domain.ts';
import { createBrowserStore } from '../src/browser-storage.ts';

const item = (change = {}) => ({
  id: 'reading',
  title: 'Чтение',
  kind: 'habit',
  startDate: '2026-11-01',
  endDate: '2026-11-30',
  time: '08:00',
  durationMinutes: 30,
  recurrence: { type: 'daily' },
  ...change,
});
const plan = (activities) => ({ schemaVersion: 1, timezone: 'Asia/Qyzylorda', goals: [], activities });

test('a one-day change keeps the occurrence ID and leaves the following day unchanged', () => {
  const activity = item({
    dateOverrides: {
      '2026-11-09': {
        time: '15:00',
        durationMinutes: 25,
        title: 'Перенесённое чтение',
        displayBlock: 'После обеда',
      },
    },
  });
  const original = structuredClone(activity);
  const rows = occurrences(plan([activity]), '2026-11-09', '2026-11-10');
  assert.deepEqual(
    rows.map((row) => [row.key, row.activity.time, row.activity.durationMinutes]),
    [
      ['reading@2026-11-09', '15:00', 25],
      ['reading@2026-11-10', '08:00', 30],
    ],
  );
  assert.equal(rows[0].activity.title, 'Перенесённое чтение');
  assert.equal(activityOnDate(activity, '2026-11-10'), activity);
  assert.deepEqual(activity, original);
  assert.equal(
    occurrences(plan([{ ...activity, excludedDates: ['2026-11-09'] }]), '2026-11-09', '2026-11-09').length,
    0,
  );
});

test('overnight one-day changes carry into the next day using the original completion key', () => {
  const activity = item({
    time: '22:00',
    durationMinutes: 60,
    dateOverrides: { '2026-11-09': { time: '23:45', durationMinutes: 90 } },
  });
  const next = daySegments(plan([activity]), '2026-11-10');
  assert.equal(next[0].start, 0);
  assert.equal(next[0].end, 75);
  assert.equal(next[0].key, 'reading@2026-11-09');
  assert.equal(next[0].continues, true);
});

test('display blocks group consecutive slots and retain each task exactly once', () => {
  const rows = daySegments(
    plan([
      item({ id: 'first', displayBlock: 'Утренний блок' }),
      item({ id: 'second', time: '08:30', displayBlock: 'Утренний блок' }),
      item({ id: 'break', time: '09:00' }),
      item({ id: 'third', time: '09:30', displayBlock: 'Утренний блок' }),
    ]),
    '2026-11-09',
  );
  const blocks = agendaBlocks(rows);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].start, 480);
  assert.equal(blocks[0].end, 540);
  assert.deepEqual(
    blocks[0].items.map((row) => row.activity.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    blocks.flatMap((block) => block.items.map((row) => row.key)),
    rows.map((row) => row.key),
  );
  assert.equal(
    blocks[0].items.some((row) => row.conflict),
    false,
  );
});

test('date changes reject invalid dates, ID changes and malformed timing or display blocks', () => {
  for (const dateOverrides of [
    [],
    { '2026-02-30': { time: '12:00' } },
    { '2026-12-01': { time: '12:00' } },
    { '2026-11-09': { id: 'other' } },
    { '2026-11-09': {} },
    { '2026-11-09': { time: '25:00' } },
    { '2026-11-09': { durationMinutes: 0 } },
    { '2026-11-09': { displayBlock: ' ' } },
    { '2026-11-09': { title: '' } },
  ])
    assert.throws(() => validateSchedule(plan([item({ dateOverrides })])));
  assert.throws(() => validateSchedule(plan([item({ displayBlock: '' })])));
  assert.doesNotThrow(() =>
    validateSchedule(
      plan([item({ displayBlock: 'Блок', dateOverrides: { '2026-11-09': { time: '12:00' } } })]),
    ),
  );
});

test('importing grouped timing changes preserves existing daily marks and the full backup', async () => {
  const values = new Map();
  const store = createBrowserStore({
    namespace: 'test',
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    loadTemplate: async () => plan([item()]),
  });
  await store.setCompleted('personal', { activityId: 'reading', date: '2026-11-09', completed: true });
  const changed = plan([item({ displayBlock: 'Вечер', dateOverrides: { '2026-11-09': { time: '18:00' } } })]);
  await store.importPersonal(JSON.stringify(changed));
  const state = await store.load('personal');
  assert.ok(state.completions.completed['reading@2026-11-09']);
  assert.equal(occurrences(state.schedule, '2026-11-09', '2026-11-09')[0].activity.time, '18:00');
  assert.deepEqual(JSON.parse(await store.exportPersonal()).schedule, changed);
});
