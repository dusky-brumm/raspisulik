import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchedule } from '../src/domain.ts';

const output = fileURLToPath(new URL('../dist-pages/', import.meta.url));
const info = JSON.parse(await readFile(path.join(output, 'build-info.json'), 'utf8'));
assert.equal(info.storage, 'browser');
const html = await readFile(path.join(output, 'index.html'), 'utf8');
const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
assert.ok(urls.length >= 3, 'Сборка должна содержать JS, CSS и favicon.');
for (const url of urls) {
  assert.ok(url.startsWith(info.base), `Неправильный путь для Pages: ${url}`);
  await readFile(path.join(output, url.slice(info.base.length)));
}
const personal = JSON.parse(await readFile(path.join(output, 'data/personal/schedule.json'), 'utf8'));
validateSchedule(personal);
assert.equal(personal.goals.length, 0, 'Публикация личных групп запрещена.');
assert.equal(personal.activities.length, 0, 'Публикация личных задач запрещена.');
assert.ok(personal.challenge, 'В стартовом шаблоне нужен челлендж.');
for (const dataset of ['personal', 'demo']) {
  assert.deepEqual(await readdir(path.join(output, 'data', dataset)), ['schedule.json'], 'В сайт не должны попадать файлы отметок.');
}
await readFile(path.join(output, '.nojekyll'));
await readFile(path.join(output, 'Inter-LICENSE.txt'));
console.log(`Pages: ${urls.length} ссылок на ресурсы проверены; челлендж доступен; личные планы и отметки исключены.`);
