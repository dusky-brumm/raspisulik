export const TIMEZONE = 'Asia/Qyzylorda';
export type DateKey = string;
export type Dataset = 'personal' | 'demo';
export type Color = 'lavender' | 'sage' | 'peach' | 'blue' | 'rose';
export type GroupType = 'goal' | 'problem' | 'project';
// The persisted `goals` / `goalId` names stay compatible with existing schedules.
export interface Goal {
  id: string;
  title: string;
  description: string;
  color: Color;
  type?: GroupType;
}
export const UNGROUPED_ID = '__ungrouped';
export type Recurrence =
  | { type: 'once' }
  | { type: 'daily' }
  | { type: 'weekly'; weekdays: number[] }
  | { type: 'interval'; everyDays: number };
export interface Activity {
  id: string;
  title: string;
  goalId?: string;
  section?: string;
  kind: 'habit' | 'task' | 'event';
  startDate: DateKey;
  endDate?: DateKey;
  time?: string;
  durationMinutes: number;
  recurrence: Recurrence;
  excludedDates?: DateKey[];
  notes?: string;
}
export interface Challenge {
  title: string;
  startDate: DateKey;
  durationDays: number;
}
export interface Schedule {
  schemaVersion: 1;
  timezone: typeof TIMEZONE;
  challenge?: Challenge;
  goals: Goal[];
  activities: Activity[];
}
export interface Completions {
  schemaVersion: 1;
  completed: Record<string, string>;
}
export interface AppState {
  schedule: Schedule;
  completions: Completions;
  today: DateKey;
}
export interface Occurrence {
  key: string;
  date: DateKey;
  activity: Activity;
}
export interface DaySegment extends Occurrence {
  start: number;
  end: number;
  continues: boolean;
  continuesAfter: boolean;
  column: number;
  columns: number;
  conflict: boolean;
}

const DAY_MS = 86_400_000;
export function parseDate(date: DateKey): Date {
  return new Date(`${date}T00:00:00Z`);
}
export function dateKey(date: Date): DateKey {
  return date.toISOString().slice(0, 10);
}
export function todayInZone(now = new Date()): DateKey {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day'].map((type) => parts.find((p) => p.type === type)!.value).join('-');
}
/** The day view uses the schedule's time zone even on another device. */
export function zonedMinutes(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return (
    Number(parts.find((part) => part.type === 'hour')!.value) * 60 +
    Number(parts.find((part) => part.type === 'minute')!.value)
  );
}
export function addDays(date: DateKey, days: number): DateKey {
  return dateKey(new Date(parseDate(date).getTime() + days * DAY_MS));
}
export function daysBetween(from: DateKey, to: DateKey): number {
  return Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / DAY_MS);
}
export function challengeProgress(challenge: Challenge, today: DateKey) {
  const elapsed = daysBetween(challenge.startDate, today);
  const endDate = addDays(challenge.startDate, challenge.durationDays - 1);
  return {
    endDate,
    day: Math.max(0, Math.min(challenge.durationDays, elapsed + 1)),
    status:
      elapsed < 0 ? ('upcoming' as const) : today > endDate ? ('finished' as const) : ('active' as const),
  };
}
export function monthStart(date: DateKey): DateKey {
  return `${date.slice(0, 7)}-01`;
}
export function shiftMonth(date: DateKey, delta: number): DateKey {
  const d = parseDate(monthStart(date));
  d.setUTCMonth(d.getUTCMonth() + delta);
  return dateKey(d);
}
export function monthDays(date: DateKey): DateKey[] {
  const start = monthStart(date),
    end = shiftMonth(start, 1);
  return Array.from({ length: daysBetween(start, end) }, (_, i) => addDays(start, i));
}
export function weekday(date: DateKey): number {
  return ((parseDate(date).getUTCDay() + 6) % 7) + 1;
}
export function formatDate(
  date: DateKey,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' },
): string {
  return new Intl.DateTimeFormat('ru-RU', { ...options, timeZone: 'UTC' }).format(parseDate(date));
}
export function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
export function clockTime(value: number): string {
  return `${String(Math.floor(value / 60) % 24).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export function duration(value: number): string {
  const h = Math.floor(value / 60),
    m = value % 60;
  return h ? `${h} ч${m ? ` ${m} мин` : ''}` : `${m} мин`;
}
export function occurrenceKey(id: string, date: DateKey): string {
  return `${id}@${date}`;
}
export function occursOn(activity: Activity, date: DateKey): boolean {
  if (
    date < activity.startDate ||
    (activity.endDate && date > activity.endDate) ||
    activity.excludedDates?.includes(date)
  )
    return false;
  switch (activity.recurrence.type) {
    case 'once':
      return date === activity.startDate;
    case 'daily':
      return true;
    case 'weekly':
      return activity.recurrence.weekdays.includes(weekday(date));
    case 'interval':
      return daysBetween(activity.startDate, date) % activity.recurrence.everyDays === 0;
  }
}
export function occurrences(schedule: Schedule, from: DateKey, to: DateKey): Occurrence[] {
  const result: Occurrence[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    for (const activity of schedule.activities) {
      if (occursOn(activity, date)) result.push({ key: occurrenceKey(activity.id, date), date, activity });
    }
  }
  return result.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.activity.time ?? '99').localeCompare(b.activity.time ?? '99') ||
      a.activity.title.localeCompare(b.activity.title, 'ru'),
  );
}
export function recurrenceLabel(activity: Activity): string {
  const r = activity.recurrence;
  if (r.type === 'once') return 'Один раз';
  if (r.type === 'daily') return 'Каждый день';
  if (r.type === 'interval') return `Раз в ${r.everyDays} дн.`;
  const names = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  return [...r.weekdays]
    .sort((a, b) => a - b)
    .map((n) => names[n - 1])
    .join(' · ');
}
export function periodLabel(activity: Activity): string {
  const start = formatDate(activity.startDate, { day: 'numeric', month: 'short', year: 'numeric' });
  if (activity.recurrence.type === 'once') return start;
  return `${start} — ${activity.endDate ? formatDate(activity.endDate, { day: 'numeric', month: 'short', year: 'numeric' }) : 'без окончания'}`;
}
export function goalFor(schedule: Schedule, activity: Activity): Goal | undefined {
  return schedule.goals.find((g) => g.id === activity.goalId);
}
export function groupTypeLabel(group: Goal): string {
  return { goal: 'Цель', problem: 'Проблема', project: 'Проект' }[group.type ?? 'goal'];
}
export function activitiesForGroup(schedule: Schedule, id: string): Activity[] {
  if (id === 'all') return schedule.activities;
  if (id === UNGROUPED_ID) return schedule.activities.filter((a) => !a.goalId);
  return schedule.activities.filter((a) => a.goalId === id);
}
export interface ActivitySection {
  title?: string;
  activities: Activity[];
}
export interface ActivityGroup {
  goal?: Goal;
  sections: ActivitySection[];
}
/** Preserve group order, section order, activity IDs, and exactly one copy of every task. */
export function organizeActivities(schedule: Schedule): ActivityGroup[] {
  const result: ActivityGroup[] = [];
  for (const goal of [...schedule.goals, undefined]) {
    const activities = schedule.activities.filter((a) => a.goalId === goal?.id);
    if (!activities.length) continue;
    const sections = new Map<string | undefined, Activity[]>();
    for (const activity of activities) {
      const title = activity.section?.trim();
      const list = sections.get(title) ?? [];
      list.push(activity);
      sections.set(title, list);
    }
    result.push({ goal, sections: [...sections].map(([title, items]) => ({ title, activities: items })) });
  }
  return result;
}
export function daySegments(schedule: Schedule, date: DateKey): DaySegment[] {
  const result: DaySegment[] = [];
  for (const o of occurrences(schedule, addDays(date, -1), date)) {
    if (!o.activity.time) continue;
    const rawStart = minutes(o.activity.time) + (o.date === date ? 0 : -1440);
    const rawEnd = rawStart + o.activity.durationMinutes;
    if (rawEnd <= 0) continue;
    result.push({
      ...o,
      start: Math.max(0, rawStart),
      end: Math.min(1440, rawEnd),
      continues: rawStart < 0,
      continuesAfter: rawEnd > 1440,
      column: 0,
      columns: 1,
      conflict: false,
    });
  }
  result.sort((a, b) => a.start - b.start || b.end - a.end);
  let group: DaySegment[] = [],
    ends: number[] = [],
    groupEnd = -1;
  const flush = () => {
    for (const item of group) item.columns = ends.length;
    group = [];
    ends = [];
  };
  for (const item of result) {
    if (item.start >= groupEnd) flush();
    let col = ends.findIndex((end) => end <= item.start);
    if (col === -1) col = ends.length;
    ends[col] = item.end;
    item.column = col;
    group.push(item);
    groupEnd = Math.max(item.end, group.length === 1 ? -1 : groupEnd);
  }
  flush();
  for (const item of result)
    item.conflict = result.some(
      (other) => other !== item && item.start < other.end && other.start < item.end,
    );
  return result;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validDate(value: unknown): value is DateKey {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < '1900-01-01' ||
    value > '2199-12-31'
  )
    return false;
  const parsed = parseDate(value);
  return !Number.isNaN(parsed.getTime()) && dateKey(parsed) === value;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value);
}
function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** One validator is shared by the local server, CLI checks, and tests. */
export function validateSchedule(value: unknown): asserts value is Schedule {
  invariant(isObject(value), 'Расписание должно быть объектом JSON.');
  invariant(value.schemaVersion === 1, 'Ожидается schemaVersion: 1.');
  invariant(value.timezone === TIMEZONE, `Укажите timezone: "${TIMEZONE}".`);
  if (value.challenge !== undefined) {
    const c = value.challenge;
    invariant(isObject(c) && validText(c.title, 120), 'Челлендж: нужно название до 120 символов.');
    invariant(validDate(c.startDate), 'Челлендж: нужна действительная startDate.');
    invariant(
      typeof c.durationDays === 'number' &&
        Number.isInteger(c.durationDays) &&
        c.durationDays >= 1 &&
        c.durationDays <= 366,
      'Челлендж: durationDays — целое число от 1 до 366.',
    );
    invariant(
      addDays(c.startDate, c.durationDays - 1) <= '2199-12-31',
      'Дата окончания челленджа должна быть не позже 2199-12-31.',
    );
  }
  invariant(
    Array.isArray(value.goals) && value.goals.length <= 200,
    'goals: ожидается массив (до 200 целей).',
  );
  invariant(
    Array.isArray(value.activities) && value.activities.length <= 2000,
    'activities: ожидается массив (до 2000 занятий).',
  );
  const goalIds = new Set<string>();
  for (const goal of value.goals) {
    invariant(
      isObject(goal) && validId(goal.id),
      'У каждой цели нужен уникальный id: латинские буквы, цифры, _ или -.',
    );
    invariant(!goalIds.has(goal.id), `Повторяется id цели: ${goal.id}.`);
    invariant(goal.id !== 'all', 'ID all зарезервирован для просмотра всех групп.');
    goalIds.add(goal.id);
    invariant(validText(goal.title, 160), `Цель ${goal.id}: нужно название (до 160 символов).`);
    invariant(
      typeof goal.description === 'string' && goal.description.length <= 3000,
      `Цель ${goal.id}: description должно быть строкой.`,
    );
    invariant(
      ['lavender', 'sage', 'peach', 'blue', 'rose'].includes(String(goal.color)),
      `Цель ${goal.id}: неизвестный цвет.`,
    );
    invariant(
      goal.type === undefined || ['goal', 'problem', 'project'].includes(String(goal.type)),
      `Группа ${goal.id}: type — goal, problem или project.`,
    );
  }
  const ids = new Set<string>();
  for (const a of value.activities) {
    invariant(
      isObject(a) && validId(a.id),
      'У каждого занятия нужен уникальный id: латинские буквы, цифры, _ или -.',
    );
    invariant(!ids.has(a.id), `Повторяется id занятия: ${a.id}.`);
    ids.add(a.id);
    const prefix = `Занятие ${a.id}: `;
    invariant(validText(a.title, 180), `${prefix}нужно название (до 180 символов).`);
    invariant(
      a.goalId === undefined || (typeof a.goalId === 'string' && goalIds.has(a.goalId)),
      `${prefix}goalId ссылается на несуществующую цель.`,
    );
    invariant(
      a.section === undefined || (validText(a.section, 100) && typeof a.goalId === 'string'),
      `${prefix}section: непустое название раздела до 100 символов; укажите goalId группы.`,
    );
    invariant(['habit', 'task', 'event'].includes(String(a.kind)), `${prefix}kind: habit, task или event.`);
    invariant(
      validDate(a.startDate),
      `${prefix}нужна действительная startDate в формате ГГГГ-ММ-ДД (1900–2199).`,
    );
    invariant(
      a.endDate === undefined || (validDate(a.endDate) && a.endDate >= a.startDate),
      `${prefix}endDate должна быть не раньше startDate.`,
    );
    invariant(
      a.time === undefined || (typeof a.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.time)),
      `${prefix}time: ЧЧ:ММ, например 09:30. Для занятия без времени уберите поле.`,
    );
    invariant(
      typeof a.durationMinutes === 'number' &&
        Number.isInteger(a.durationMinutes) &&
        a.durationMinutes >= 1 &&
        a.durationMinutes <= 1440,
      `${prefix}durationMinutes: целое число от 1 до 1440.`,
    );
    invariant(
      a.notes === undefined || (typeof a.notes === 'string' && a.notes.length <= 5000),
      `${prefix}notes должно быть строкой до 5000 символов.`,
    );
    invariant(isObject(a.recurrence), `${prefix}нужно правило recurrence.`);
    const r = a.recurrence;
    invariant(
      ['once', 'daily', 'weekly', 'interval'].includes(String(r.type)),
      `${prefix}неизвестный тип повторения.`,
    );
    if (r.type === 'once')
      invariant(
        a.endDate === undefined || a.endDate === a.startDate,
        `${prefix}у разового события endDate совпадает с startDate либо отсутствует.`,
      );
    if (r.type === 'weekly')
      invariant(
        Array.isArray(r.weekdays) &&
          r.weekdays.length > 0 &&
          r.weekdays.length <= 7 &&
          r.weekdays.every((n) => Number.isInteger(n) && n >= 1 && n <= 7) &&
          new Set(r.weekdays).size === r.weekdays.length,
        `${prefix}weekdays: неповторяющиеся числа 1–7 (пн–вс).`,
      );
    if (r.type === 'interval')
      invariant(
        typeof r.everyDays === 'number' &&
          Number.isInteger(r.everyDays) &&
          r.everyDays >= 1 &&
          r.everyDays <= 3650,
        `${prefix}everyDays: целое число от 1 до 3650.`,
      );
    invariant(
      a.excludedDates === undefined || (Array.isArray(a.excludedDates) && a.excludedDates.every(validDate)),
      `${prefix}excludedDates: массив действительных дат.`,
    );
  }
}

export function validateCompletions(value: unknown): asserts value is Completions {
  invariant(
    isObject(value) && value.schemaVersion === 1 && isObject(value.completed),
    'Файл отметок повреждён: ожидается {schemaVersion: 1, completed: {}}.',
  );
  for (const [key, timestamp] of Object.entries(value.completed)) {
    const [id, date, extra] = key.split('@');
    invariant(
      !extra &&
        validId(id) &&
        validDate(date) &&
        typeof timestamp === 'string' &&
        !Number.isNaN(Date.parse(timestamp)),
      `Некорректная отметка: ${key}.`,
    );
  }
}
