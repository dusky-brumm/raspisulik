import {
  occurrenceKey,
  occursOn,
  todayInZone,
  validDate,
  validateCompletions,
  validateSchedule,
} from './domain.ts';
import type { AppState, Completions, Dataset, Schedule } from './domain.ts';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
type Exclusive = <T>(operation: () => Promise<T>) => Promise<T>;
interface SavedData {
  schemaVersion: 1;
  schedule?: Schedule;
  completions: Completions;
}
const emptyCompletions = (): Completions => ({ schemaVersion: 1, completed: {} });
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createBrowserStore(options: {
  storage: Store;
  namespace: string;
  loadTemplate: (dataset: Dataset) => Promise<Schedule>;
  now?: () => Date;
  exclusive?: Exclusive;
}) {
  const now = options.now ?? (() => new Date());
  let queue: Promise<unknown> = Promise.resolve();
  const key = (dataset: Dataset) => `${options.namespace}:${dataset}`;

  function saved(dataset: Dataset): SavedData {
    const text = options.storage.getItem(key(dataset));
    if (!text) return { schemaVersion: 1, completions: emptyCompletions() };
    const value: unknown = JSON.parse(text);
    if (!object(value) || value.schemaVersion !== 1)
      throw new Error('Не удалось прочитать сохранённые данные браузера.');
    if (value.schedule !== undefined) validateSchedule(value.schedule);
    validateCompletions(value.completions);
    return value as unknown as SavedData;
  }
  async function load(dataset: Dataset): Promise<AppState> {
    const data = saved(dataset);
    const schedule = data.schedule ?? (await options.loadTemplate(dataset));
    validateSchedule(schedule);
    return { schedule, completions: data.completions, today: todayInZone(now()) };
  }
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue
      .catch(() => {})
      .then(() => (options.exclusive ? options.exclusive(operation) : operation()));
    queue = next;
    return next;
  }
  function write(dataset: Dataset, value: SavedData) {
    // One setItem is atomic; quota/permission errors leave the previous value intact.
    options.storage.setItem(key(dataset), JSON.stringify(value));
  }
  function setCompleted(
    dataset: Dataset,
    input: { activityId: string; date: string; completed: boolean },
  ): Promise<Completions> {
    return mutate(async () => {
      const state = await load(dataset);
      const a = state.schedule.activities.find((item) => item.id === input.activityId);
      if (!a || !validDate(input.date) || typeof input.completed !== 'boolean' || !occursOn(a, input.date))
        throw new Error('В этот день занятие не запланировано. Обновите расписание.');
      const completionKey = occurrenceKey(a.id, input.date);
      if (input.completed) state.completions.completed[completionKey] = now().toISOString();
      else delete state.completions.completed[completionKey];
      const current = saved(dataset);
      write(dataset, { ...current, completions: state.completions });
      return state.completions;
    });
  }
  async function exportPersonal(): Promise<string> {
    const { schedule, completions } = await load('personal');
    return JSON.stringify({ format: 'raspisulik-backup', version: 1, schedule, completions }, null, 2);
  }
  function importPersonal(text: string): Promise<void> {
    return mutate(async () => {
      const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      let schedule: unknown = value;
      let completions: Completions;
      if (object(value) && value.format === 'raspisulik-backup') {
        if (value.version !== 1) throw new Error('Эта версия резервной копии не поддерживается.');
        schedule = value.schedule;
        validateCompletions(value.completions);
        completions = value.completions;
      } else completions = saved('personal').completions;
      validateSchedule(schedule);
      write('personal', { schemaVersion: 1, schedule, completions });
    });
  }
  return { load, setCompleted, exportPersonal, importPersonal };
}
