import { createBrowserStore } from './browser-storage';
import { todayInZone, validateCompletions, validateSchedule } from './domain';
import type { AppState, Dataset } from './domain';

const browserMode = import.meta.env.VITE_STORAGE_MODE === 'browser';
const namespace = `raspisulik:v1:${import.meta.env.BASE_URL}`;
const browserStore = browserMode
  ? createBrowserStore({
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      },
      namespace,
      loadTemplate: async (dataset) => {
        const response = await fetch(`${import.meta.env.BASE_URL}data/${dataset}/schedule.json`, {
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Не удалось загрузить расписание сайта.');
        const schedule: unknown = await response.json();
        validateSchedule(schedule);
        return schedule;
      },
      exclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
        if (navigator.locks) return await navigator.locks.request(namespace, operation);
        return await operation();
      },
    })
  : null;

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Не удалось обновить расписание.');
  return value;
}
export const dataClient = {
  browser: browserMode,
  async load(dataset: Dataset): Promise<AppState> {
    if (browserStore) return browserStore.load(dataset);
    const value = await request(`/api/state?dataset=${dataset}`);
    validateSchedule(value.schedule);
    validateCompletions(value.completions);
    return { ...value, today: todayInZone() };
  },
  async setCompleted(dataset: Dataset, input: { activityId: string; date: string; completed: boolean }) {
    if (browserStore) return browserStore.setCompleted(dataset, input);
    const value = await request(`/api/completions?dataset=${dataset}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    validateCompletions(value);
    return value;
  },
  async exportPersonal(): Promise<string> {
    if (browserStore) return browserStore.exportPersonal();
    const { schedule, completions } = await this.load('personal');
    return JSON.stringify({ format: 'raspisulik-backup', version: 1, schedule, completions }, null, 2);
  },
  async importPersonal(text: string) {
    if (!browserStore) throw new Error('В локальном режиме измените data/personal/schedule.json.');
    return browserStore.importPersonal(text);
  },
};
