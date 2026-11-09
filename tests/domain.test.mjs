import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activitiesForGroup,
  addDays,
  challengeProgress,
  daysBetween,
  groupTypeLabel,
  monthDays,
  occurrences,
  occursOn,
  organizeActivities,
  daySegments,
  todayInZone,
  zonedMinutes,
  UNGROUPED_ID,
  validateSchedule,
  validateCompletions,
} from '../src/domain.ts';

const activity = (overrides = {}) => ({
  id: 'read',
  title: 'Чтение',
  kind: 'habit',
  startDate: '2026-11-01',
  durationMinutes: 20,
  recurrence: { type: 'daily' },
  ...overrides,
});
const schedule = (activities) => ({ schemaVersion: 1, timezone: 'Asia/Qyzylorda', goals: [], activities });

test('weekly course includes both boundaries and only selected weekdays', () => {
  const a = activity({
    startDate: '2026-11-02',
    endDate: '2026-11-15',
    recurrence: { type: 'weekly', weekdays: [1, 3, 5] },
    excludedDates: ['2026-11-11'],
  });
  assert.deepEqual(
    occurrences(schedule([a]), '2026-10-30', '2026-11-18').map((o) => o.date),
    ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-09', '2026-11-13'],
  );
  const daily = activity({ startDate: '2026-11-02', endDate: '2026-11-03' });
  assert.deepEqual(
    occurrences(schedule([daily]), '2026-11-01', '2026-11-04').map((o) => o.date),
    ['2026-11-02', '2026-11-03'],
  );
});
test('intervals remain anchored across months, leap days, years and exclusions', () => {
  const a = activity({
    startDate: '2024-02-27',
    endDate: '2024-03-04',
    recurrence: { type: 'interval', everyDays: 2 },
    excludedDates: ['2024-02-29'],
  });
  assert.deepEqual(
    occurrences(schedule([a]), '2024-02-26', '2024-03-05').map((o) => o.date),
    ['2024-02-27', '2024-03-02', '2024-03-04'],
  );
  assert.equal(
    occursOn(
      activity({ startDate: '2026-12-30', recurrence: { type: 'interval', everyDays: 3 } }),
      '2027-01-02',
    ),
    true,
  );
});
test('daily recurrence can be open-ended and once does not repeat', () => {
  assert.equal(occursOn(activity(), '2028-05-01'), true);
  assert.equal(occursOn(activity(), '2026-10-31'), false);
  const once = activity({ recurrence: { type: 'once' } });
  assert.deepEqual(
    occurrences(schedule([once]), '2026-11-01', '2026-11-30').map((o) => o.key),
    ['read@2026-11-01'],
  );
});
test('calendar arithmetic is independent of host timezone', () => {
  assert.equal(todayInZone(new Date('2026-11-08T18:59:59Z')), '2026-11-08');
  assert.equal(todayInZone(new Date('2026-11-08T19:00:00Z')), '2026-11-09');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(monthDays('2024-02-20').length, 29);
  assert.equal(monthDays('2026-02-20').length, 28);
});

test('current-time marker uses Qyzylorda time and resets to zero at midnight', () => {
  assert.equal(zonedMinutes(new Date('2026-11-08T18:59:59Z')), 1439);
  assert.equal(zonedMinutes(new Date('2026-11-08T19:00:00Z')), 0);
  assert.equal(zonedMinutes(new Date('2026-11-09T01:30:00Z')), 390);
});
test('untimed tasks stay out of the time grid; overlaps have separate columns', () => {
  const items = [
    activity(),
    activity({ id: 'a', time: '10:00', durationMinutes: 60 }),
    activity({ id: 'b', time: '10:30', durationMinutes: 60 }),
    activity({ id: 'c', time: '11:30', durationMinutes: 30 }),
  ];
  const segments = daySegments(schedule(items), '2026-11-08');
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((s) => [s.activity.id, s.column, s.columns, s.conflict]),
    [
      ['a', 0, 2, true],
      ['b', 1, 2, true],
      ['c', 0, 1, false],
    ],
  );
});
test('overlap groups with three simultaneous events allocate enough columns', () => {
  const segments = daySegments(
    schedule([
      activity({ id: 'a', time: '10:00', durationMinutes: 90 }),
      activity({ id: 'b', time: '10:10', durationMinutes: 20 }),
      activity({ id: 'c', time: '10:15', durationMinutes: 30 }),
      activity({ id: 'd', time: '10:30', durationMinutes: 10 }),
    ]),
    '2026-11-08',
  );
  assert.ok(segments.every((s) => s.columns === 3 && s.conflict));
  assert.equal(segments.find((s) => s.activity.id === 'd').column, 1);
});
test('overnight events keep the start-date completion key and conflict on next day', () => {
  const overnight = activity({
    id: 'night',
    startDate: '2026-11-08',
    time: '23:40',
    durationMinutes: 60,
    recurrence: { type: 'once' },
  });
  const early = activity({
    id: 'early',
    startDate: '2026-11-09',
    time: '00:15',
    durationMinutes: 30,
    recurrence: { type: 'once' },
  });
  const first = daySegments(schedule([overnight, early]), '2026-11-08');
  const second = daySegments(schedule([overnight, early]), '2026-11-09');
  assert.equal(first[0].end - first[0].start, 20);
  assert.equal(first[0].continuesAfter, true);
  assert.equal(second[0].end - second[0].start, 40);
  assert.equal(second[0].continues, true);
  assert.equal(second[0].key, first[0].key);
  assert.ok(second.every((s) => s.conflict));
  assert.equal(daySegments(schedule([overnight]), '2026-11-10').length, 0);
});
test('validator rejects impossible dates, missing goals and malformed recurrence', () => {
  for (const invalid of [
    { startDate: '2026-02-30' },
    { endDate: '2026-10-31' },
    { time: '24:00' },
    { time: null },
    { durationMinutes: 0 },
    { durationMinutes: 1.5 },
    { goalId: 'unknown' },
    { recurrence: { type: 'weekly', weekdays: [] } },
    { recurrence: { type: 'weekly', weekdays: [1, 1] } },
    { recurrence: { type: 'interval', everyDays: 0 } },
    { excludedDates: ['2026-11-31'] },
    { recurrence: { type: 'once' }, endDate: '2026-11-02' },
  ])
    assert.throws(() => validateSchedule(schedule([activity(invalid)])));
  assert.throws(() => validateSchedule(schedule([activity(), activity()])));
  assert.doesNotThrow(() => validateSchedule(schedule([activity()])));
  assert.doesNotThrow(() => validateSchedule(schedule([])));
});
test('completion file validation rejects corrupt data', () => {
  assert.throws(() =>
    validateCompletions({ schemaVersion: 1, completed: { 'read@2026-02-30': new Date().toISOString() } }),
  );
  assert.throws(() =>
    validateCompletions({ schemaVersion: 1, completed: { 'read@2026-11-08': 'not a date' } }),
  );
  assert.doesNotThrow(() => validateCompletions({ schemaVersion: 1, completed: {} }));
});

test('goals, problems and projects are optional backwards-compatible group types', () => {
  const group = { id: 'fitness', title: 'Привести себя в форму', description: '', color: 'sage' };
  const value = { ...schedule([]), goals: [group] };
  assert.doesNotThrow(() => validateSchedule(value));
  assert.equal(groupTypeLabel(group), 'Цель');
  for (const [type, label] of [
    ['goal', 'Цель'],
    ['problem', 'Проблема'],
    ['project', 'Проект'],
  ]) {
    const typed = { ...group, type };
    assert.doesNotThrow(() => validateSchedule({ ...value, goals: [typed] }));
    assert.equal(groupTypeLabel(typed), label);
  }
  for (const type of ['task', '', null])
    assert.throws(() => validateSchedule({ ...value, goals: [{ ...group, type }] }));
  assert.throws(() => validateSchedule({ ...value, goals: [{ ...group, id: 'all' }] }));
});

test('a broad group contains multiple sections and each task appears exactly once', () => {
  const goals = [
    { id: 'fitness', title: 'Форма', description: '', color: 'sage' },
    { id: 'project', title: 'Проект', description: '', color: 'blue', type: 'project' },
    { id: 'empty', title: 'Пустая группа', description: '', color: 'peach' },
  ];
  const items = [
    activity({ id: 'meal', goalId: 'fitness', section: 'Питание' }),
    activity({ id: 'reading', goalId: 'project' }),
    activity({ id: 'walk', goalId: 'fitness', section: 'Движение' }),
    activity({ id: 'free' }),
    activity({ id: 'stretch', goalId: 'fitness', section: ' Движение ' }),
    activity({ id: 'general', goalId: 'fitness' }),
  ];
  const value = { ...schedule(items), goals };
  validateSchedule(value);
  const result = organizeActivities(value);
  assert.deepEqual(
    result.map((g) => g.goal?.id),
    ['fitness', 'project', undefined],
  );
  assert.deepEqual(
    result[0].sections.map((s) => [s.title, s.activities.map((a) => a.id)]),
    [
      ['Питание', ['meal']],
      ['Движение', ['walk', 'stretch']],
      [undefined, ['general']],
    ],
  );
  const all = result.flatMap((g) => g.sections.flatMap((s) => s.activities));
  assert.equal(all.length, items.length);
  assert.equal(new Set(all.map((a) => a.id)).size, items.length);
  assert.deepEqual(
    activitiesForGroup(value, 'fitness').map((a) => a.id),
    ['meal', 'walk', 'stretch', 'general'],
  );
  assert.deepEqual(
    activitiesForGroup(value, UNGROUPED_ID).map((a) => a.id),
    ['free'],
  );
  assert.equal(activitiesForGroup(value, 'all').length, items.length);
  assert.equal(activitiesForGroup(value, 'empty').length, 0);
  assert.equal(activitiesForGroup(value, 'missing').length, 0);
  assert.deepEqual(
    items.map((a) => a.id),
    ['meal', 'reading', 'walk', 'free', 'stretch', 'general'],
  );
});

test('sections require a parent group and cannot be blank or malformed', () => {
  const goals = [{ id: 'fitness', title: 'Форма', description: '', color: 'sage' }];
  const value = { ...schedule([]), goals };
  for (const invalid of [
    { section: 'Питание' },
    { goalId: 'fitness', section: '' },
    { goalId: 'fitness', section: '   ' },
    { goalId: 'fitness', section: 123 },
    { goalId: 'missing', section: 'Движение' },
    { goalId: 'fitness', section: 'д'.repeat(101) },
  ])
    assert.throws(() => validateSchedule({ ...value, activities: [activity(invalid)] }));
  assert.doesNotThrow(() => validateSchedule({ ...value, activities: [activity({ goalId: 'fitness' })] }));
});

test('30-day challenge has inclusive bounds and never displays day 31 of 30', () => {
  const c = { title: '30 дней', startDate: '2026-11-08', durationDays: 30 };
  assert.deepEqual(challengeProgress(c, '2026-11-07'), { day: 0, endDate: '2026-12-07', status: 'upcoming' });
  assert.deepEqual(challengeProgress(c, '2026-11-08'), { day: 1, endDate: '2026-12-07', status: 'active' });
  assert.deepEqual(challengeProgress(c, '2026-12-07'), { day: 30, endDate: '2026-12-07', status: 'active' });
  assert.deepEqual(challengeProgress(c, '2026-12-08'), {
    day: 30,
    endDate: '2026-12-07',
    status: 'finished',
  });
  assert.equal(challengeProgress({ ...c, startDate: '2024-02-28', durationDays: 3 }, '2024-03-01').day, 3);
});
test('challenge validation rejects bad dates, durations and overflowing end dates', () => {
  const base = { title: '30 дней', startDate: '2026-11-08', durationDays: 30 };
  for (const changes of [
    { title: '' },
    { startDate: '2026-02-30' },
    { durationDays: 0 },
    { durationDays: 1.5 },
    { durationDays: 367 },
    { startDate: '2199-12-31', durationDays: 2 },
  ]) {
    assert.throws(() => validateSchedule({ ...schedule([]), challenge: { ...base, ...changes } }));
  }
  assert.doesNotThrow(() => validateSchedule({ ...schedule([]), challenge: base }));
  assert.doesNotThrow(() => validateSchedule(schedule([])));
});
