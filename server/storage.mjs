import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateSchedule, validateCompletions, validDate, occursOn, occurrenceKey } from '../src/domain.ts';

export function createStore(dataRoot) {
  // Only this queue writes completions; schedule files are always read-only here.
  let queue = Promise.resolve();
  function directory(dataset) {
    if (!['personal', 'demo'].includes(dataset)) throw new Error('Неизвестный набор данных.');
    return path.join(dataRoot, dataset);
  }
  async function readJSON(file) {
    try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw new Error(`Не удалось прочитать ${path.basename(file)}: ${error.message}`);
    }
  }
  async function loadSchedule(dataset) {
    const schedule = await readJSON(path.join(directory(dataset), 'schedule.json'));
    validateSchedule(schedule);
    return schedule;
  }
  async function loadCompletions(dataset) {
    let completions;
    try { completions = await readJSON(path.join(directory(dataset), 'completions.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      completions = { schemaVersion: 1, completed: {} };
    }
    validateCompletions(completions);
    return completions;
  }
  async function load(dataset) {
    const [schedule, completions] = await Promise.all([loadSchedule(dataset), loadCompletions(dataset)]);
    return { schedule, completions };
  }
  function setCompleted(dataset, input) {
    const operation = queue.catch(() => {}).then(async () => {
      if (!input || typeof input.activityId !== 'string' || typeof input.date !== 'string' || typeof input.completed !== 'boolean') throw new Error('Нужны activityId, date и completed.');
      const { schedule, completions } = await load(dataset);
      const activity = schedule.activities.find(a => a.id === input.activityId);
      if (!activity || !validDate(input.date) || !occursOn(activity, input.date)) throw new Error('В этот день занятие не запланировано. Обновите расписание.');
      const key = occurrenceKey(activity.id, input.date);
      if (input.completed) completions.completed[key] = new Date().toISOString();
      else delete completions.completed[key];
      validateCompletions(completions);
      const dir = directory(dataset);
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, 'completions.json');
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(completions, null, 2) + '\n', { flag: 'wx' });
        await rename(temp, target);
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return completions;
    });
    queue = operation;
    return operation;
  }
  return { load, setCompleted };
}
