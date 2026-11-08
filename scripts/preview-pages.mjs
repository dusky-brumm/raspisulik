import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const info = JSON.parse(await readFile(new URL('../dist-pages/build-info.json', import.meta.url), 'utf8'));
const server = await preview({ root, base: info.base, build: { outDir: 'dist-pages' }, preview: { host: '127.0.0.1', port: 4174, strictPort: true } });
server.printUrls();
