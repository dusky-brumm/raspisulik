import { spawnSync } from 'node:child_process';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist-pages');
function git(args, options = {}) {
  const result = spawnSync('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], {
    cwd: options.cwd || root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Git failed: ${args[0]}`);
  return result.stdout.trim();
}
if (git(['status', '--porcelain'])) throw new Error('Сначала сохраните изменения исходников коммитом.');
const remote = git(['remote', 'get-url', 'origin']);
const match = /^https:\/\/github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9._-]+?)(?:\.git)?$/.exec(remote);
if (!match) throw new Error('origin должен указывать на HTTPS-репозиторий GitHub.');
const info = JSON.parse(await readFile(path.join(output, 'build-info.json'), 'utf8'));
if (info.storage !== 'browser' || info.base !== `/${match[2]}/`) throw new Error('Сборка не соответствует имени репозитория или режиму Pages.');
await readFile(path.join(output, 'index.html'));
const previous = git(['ls-remote', '--heads', 'origin', 'refs/heads/gh-pages']).split(/\s/)[0];
if (previous) {
  if (!/^[a-f0-9]{40}$/.test(previous)) throw new Error('Не удалось проверить предыдущую публикацию.');
  git(['fetch', 'origin', 'gh-pages']);
}
const source = git(['rev-parse', 'HEAD']);
const gitDir = git(['rev-parse', '--absolute-git-dir']);
await mkdir(path.join(root, '.local'), { recursive: true });
const index = path.join(root, '.local', `pages-index-${randomUUID()}`);
try {
  const options = { cwd: output, env: { GIT_INDEX_FILE: index } };
  const context = [`--git-dir=${gitDir}`, `--work-tree=${output}`];
  git([...context, 'read-tree', '--empty'], options);
  git([...context, 'add', '--all', '--force', '--', '.'], options);
  const tree = git([...context, 'write-tree'], options);
  const args = ['commit-tree', tree, ...(previous ? ['-p', previous] : []), '-m', `Publish Raspisulik from ${source.slice(0, 12)}`];
  const commit = git(args);
  // Normal fast-forward push: a simultaneous publication is rejected, never overwritten.
  git(['push', 'origin', `${commit}:refs/heads/gh-pages`]);
  console.log(`Published ${commit} → https://${match[1]}.github.io/${match[2]}/`);
} finally {
  for (const file of [index, `${index}.lock`]) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
