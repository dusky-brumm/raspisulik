import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { validateSchedule } from '../src/domain.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = process.env.PAGES_BASE || '/raspisulik/';
if (!/^\/(?:[a-zA-Z0-9._-]+\/)*$/.test(base)) throw new Error('PAGES_BASE должен быть путём вида /raspisulik/.');
process.env.VITE_STORAGE_MODE = 'browser';
await build({ root, base, build: { outDir: 'dist-pages', emptyOutDir: true } });

// Publication allowlist never reads the user's private schedule or completion files.
for (const [dataset, source] of [['personal', 'published'], ['demo', 'demo']]) {
  const schedule = JSON.parse(await readFile(path.join(root, 'data', source, 'schedule.json'), 'utf8'));
  validateSchedule(schedule);
  if (dataset === 'personal' && (schedule.goals.length || schedule.activities.length)) throw new Error('Публичный стартовый шаблон должен быть пустым. Личные планы импортируются в браузере.');
  const destination = path.join(root, 'dist-pages', 'data', dataset);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'schedule.json'), JSON.stringify(schedule, null, 2) + '\n');
}
await writeFile(path.join(root, 'dist-pages', '.nojekyll'), '');
await writeFile(path.join(root, 'dist-pages', 'build-info.json'), JSON.stringify({ storage: 'browser', base }, null, 2) + '\n');
await copyFile(path.join(root, 'node_modules/@fontsource/inter/LICENSE'), path.join(root, 'dist-pages', 'Inter-LICENSE.txt'));
console.log(`GitHub Pages build: dist-pages, base ${base}. Personal data excluded.`);
