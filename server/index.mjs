import http from 'node:http';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore } from './storage.mjs';
import { todayInZone } from '../src/domain.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'data/personal'), { recursive: true });
await copyFile(path.join(root, 'data/published/schedule.json'), path.join(root, 'data/personal/schedule.json'), constants.COPYFILE_EXCL)
  .catch(error => { if (error.code !== 'EEXIST') throw error; });
const port = Number(process.env.PORT || 4173);
const dev = process.argv.includes('--dev');
const store = createStore(path.join(root, 'data'));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
let vite;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw new Error('Слишком большой запрос.');
  }
  try { return JSON.parse(body); } catch { throw new Error('Некорректный JSON в запросе.'); }
}
const server = http.createServer(async (req, res) => {
  // Bind and host checks keep the personal API on this computer.
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Доступ разрешён только с этого компьютера.' });
  if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) return json(res, 403, { error: 'Недопустимый источник запроса.' });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { app: 'raspisulik', version: 1 });
      if (url.pathname === '/api/workout-archive' && req.method === 'GET') {
        try {
          const body = await readFile(path.join(root, 'data/personal/workouts.zip'));
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(body);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          return res.end();
        }
      }
      const dataset = url.searchParams.get('dataset') || 'personal';
      if (!['personal', 'demo'].includes(dataset)) return json(res, 400, { error: 'Неизвестный набор данных.' });
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, { ...await store.load(dataset), today: todayInZone() });
      if (url.pathname === '/api/completions' && req.method === 'PUT') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'Ожидается application/json.' });
        return json(res, 200, await store.setCompleted(dataset, await readBody(req)));
      }
      return json(res, 404, { error: 'Такого действия нет.' });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Метод не поддерживается.' });
  if (dev) return vite.middlewares(req, res, () => { res.writeHead(404); res.end('Не найдено'); });
  try {
    const decoded = decodeURIComponent(url.pathname);
    let relative = decoded === '/' ? 'index.html' : decoded.slice(1);
    if (relative.includes('\\') || relative.split('/').some(p => p === '..' || p.startsWith('.'))) return json(res, 404, { error: 'Не найдено.' });
    let file = path.resolve(root, 'dist', relative);
    if (!file.startsWith(path.join(root, 'dist') + path.sep)) return json(res, 404, { error: 'Не найдено.' });
    try { if (!(await stat(file)).isFile()) throw new Error('not-file'); }
    catch { if (path.extname(relative)) return json(res, 404, { error: 'Не найдено.' }); file = path.join(root, 'dist/index.html'); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не удалось открыть приложение. Выполните npm run build в папке проекта.');
    console.error(error.message);
  }
});
if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
} else {
  try { await stat(path.join(root, 'dist/index.html')); }
  catch { console.error('Сначала выполните npm run build, либо запустите npm run dev.'); process.exit(1); }
}
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Порт ${port} уже занят. Возможно, приложение уже открыто: http://127.0.0.1:${port}` : error.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`\nРасписулик работает локально → http://127.0.0.1:${port}\nРежим: ${dev ? 'разработка' : 'обычный'} · Данные: ${path.join(root, 'data')}\n`));
async function stop() { await vite?.close(); server.close(() => process.exit(0)); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
