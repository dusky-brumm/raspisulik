import { readFile } from 'node:fs/promises';
import { validateSchedule } from '../src/domain.ts';

let failed = false;
for (const dataset of ['personal', 'demo', 'published']) {
  try {
    const value = JSON.parse((await readFile(new URL(`../data/${dataset}/schedule.json`, import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
    validateSchedule(value);
    console.log(`${dataset}: ${value.goals.length} групп, ${value.activities.length} занятий — данные корректны.`);
  } catch (error) {
    if (dataset === 'personal' && error.code === 'ENOENT') { console.log('personal: файл будет создан при первом локальном запуске.'); continue; }
    console.error(`${dataset}: ${error.message}`); failed = true;
  }
}
if (failed) process.exitCode = 1;
