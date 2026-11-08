import { validDate } from './domain.ts';
import type { Dataset, DateKey } from './domain.ts';

export interface VideoCollection { id: string; dataset: Dataset; title: string; activityId?: string; createdAt: string }
export interface VideoClip { id: string; collectionId: string; title: string; filename: string; source: string; size: number; modified: number; type: string; order: number; hidden: boolean; youtubeId?: string }
export interface VideoMark { id: string; collectionId: string; videoId: string; date: DateKey; completedAt: string }
export interface VideoLibrary { collections: VideoCollection[]; clips: VideoClip[]; marks: VideoMark[] }
const videoExtensions = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv|avi)$/i;
export function isVideoFile(file: Pick<File, 'name' | 'type' | 'size'>) { return file.size > 0 && (file.type.startsWith('video/') || videoExtensions.test(file.name)); }
export function videoTitle(filename: string) { return filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim().slice(0, 180) || 'Видео'; }
export function youtubeIdFromUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Укажите полную ссылку на ролик YouTube.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Нужна безопасная ссылка https:// на YouTube.');
  let id: string | null = null;
  if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) id = url.pathname.split('/')[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
    const parts = url.pathname.split('/');
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else if (['embed', 'shorts', 'live'].includes(parts[1])) id = parts[2];
  }
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) throw new Error('Не удалось найти ролик в ссылке YouTube.');
  return id;
}
export function videoProgress(clips: VideoClip[], marks: VideoMark[], collectionId: string, date: DateKey) {
  const active = clips.filter(c => c.collectionId === collectionId && !c.hidden);
  const done = new Set(marks.filter(m => m.collectionId === collectionId && m.date === date).map(m => m.videoId));
  const completed = active.filter(c => done.has(c.id)).length;
  return { completed, total: active.length, allDone: active.length > 0 && completed === active.length };
}
function title(value: string) { const text = value.trim(); if (!text || text.length > 180) throw new Error('Введите название до 180 символов.'); return text; }
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }

/** Blobs stay in their own store: loading the library never loads video contents. */
export function createVideoStore(options: { name: string; factory?: IDBFactory; now?: () => Date }) {
  let opened: Promise<IDBDatabase> | undefined;
  const now = options.now ?? (() => new Date());
  function database() {
    if (!opened) opened = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = options.factory ?? globalThis.indexedDB;
      if (!factory) { reject(new Error('Браузер не поддерживает хранение видео.')); return; }
      const opening = factory.open(options.name, 1);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        db.createObjectStore('collections', { keyPath: 'id' }).createIndex('dataset', 'dataset');
        db.createObjectStore('clips', { keyPath: 'id' }).createIndex('collection', 'collectionId');
        db.createObjectStore('media');
        db.createObjectStore('marks', { keyPath: 'id' }).createIndex('day', ['collectionId', 'date']);
      };
      opening.onerror = () => { opened = undefined; reject(opening.error); };
      opening.onblocked = () => { opened = undefined; reject(new Error('Закройте другие вкладки Расписулика и повторите.')); };
      opening.onsuccess = () => { const db = opening.result; db.onversionchange = () => { db.close(); opened = undefined; }; resolve(db); };
    });
    return opened;
  }
  async function transaction<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T, failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Не удалось сохранить видео.'));
      void work(tx).then(value => { result = value; }).catch(error => { failure = error; try { tx.abort(); } catch { reject(error); } });
    });
  }
  async function collection(tx: IDBTransaction, dataset: Dataset, id: string): Promise<VideoCollection> {
    const value = await request<VideoCollection | undefined>(tx.objectStore('collections').get(id));
    if (!value || value.dataset !== dataset) throw new Error('Подборка не найдена. Обновите список.');
    return value;
  }
  async function uniqueLink(tx: IDBTransaction, dataset: Dataset, activityId?: string, except?: string) {
    if (!activityId) return;
    const rows = await request<VideoCollection[]>(tx.objectStore('collections').index('dataset').getAll(dataset));
    if (rows.some(c => c.activityId === activityId && c.id !== except)) throw new Error('К этой задаче уже привязана другая подборка.');
  }
  async function list(dataset: Dataset, date: DateKey): Promise<VideoLibrary> {
    if (!validDate(date)) throw new Error('Выберите действительную дату.');
    return transaction(['collections', 'clips', 'marks'], 'readonly', async tx => {
      const collections = await request<VideoCollection[]>(tx.objectStore('collections').index('dataset').getAll(dataset));
      collections.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const groups = await Promise.all(collections.map(async c => ({
        clips: await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(c.id)),
        marks: await request<VideoMark[]>(tx.objectStore('marks').index('day').getAll([c.id, date])),
      })));
      return { collections, clips: groups.flatMap(g => g.clips).sort((a, b) => a.order - b.order), marks: groups.flatMap(g => g.marks) };
    });
  }
  async function create(dataset: Dataset, name: string, activityId?: string) {
    const value: VideoCollection = { id: crypto.randomUUID(), dataset, title: title(name), createdAt: now().toISOString(), ...(activityId ? { activityId } : {}) };
    return transaction(['collections'], 'readwrite', async tx => {
      await uniqueLink(tx, dataset, activityId);
      await request(tx.objectStore('collections').add(value));
      return value;
    });
  }
  async function updateCollection(dataset: Dataset, id: string, name: string, activityId?: string) {
    const nameText = title(name);
    return transaction(['collections'], 'readwrite', async tx => {
      const current = await collection(tx, dataset, id);
      await uniqueLink(tx, dataset, activityId, id);
      const value = { ...current, title: nameText, activityId };
      await request(tx.objectStore('collections').put(value));
      return value;
    });
  }
  async function addFiles(dataset: Dataset, id: string, files: File[]) {
    const videos = files.filter(isVideoFile).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'ru', { numeric: true }));
    if (!videos.length) throw new Error('В выбранных файлах нет видео. Выберите MP4, WebM или другой видеофайл.');
    if (videos.length > 200) throw new Error('Добавьте не больше 200 роликов за один раз.');
    return transaction(['collections', 'clips', 'media'], 'readwrite', async tx => {
      await collection(tx, dataset, id);
      const existing = await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(id));
      let order = Math.max(-1, ...existing.map(c => c.order)) + 1, added = 0, restored = 0;
      for (const file of videos) {
        const source = file.webkitRelativePath || file.name;
        const same = existing.find(c => c.size === file.size && c.modified === file.lastModified &&
          (c.source === source || (c.filename === file.name && (!c.source.includes('/') || !source.includes('/')))));
        if (same) {
          let recovered = false;
          if (!same.source.includes('/') && source.includes('/')) { same.source = source; await request(tx.objectStore('clips').put(same)); }
          if (same.hidden) { same.hidden = false; same.order = order++; await request(tx.objectStore('clips').put(same)); recovered = true; }
          if (!await request(tx.objectStore('media').get(same.id))) { await request(tx.objectStore('media').put(file.slice(0, file.size, same.type), same.id)); recovered = true; }
          if (recovered) restored++;
          continue;
        }
        const type = file.type || ({ mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg' }[file.name.split('.').at(-1)!.toLowerCase()] ?? 'application/octet-stream');
        const clip: VideoClip = { id: crypto.randomUUID(), collectionId: id, title: videoTitle(file.name), filename: file.name, source, size: file.size, modified: file.lastModified, type, order: order++, hidden: false };
        await request(tx.objectStore('clips').add(clip));
        await request(tx.objectStore('media').add(file.slice(0, file.size, type), clip.id));
        existing.push(clip); added++;
      }
      return { added, restored, skipped: files.length - added - restored };
    });
  }
  async function updateClip(dataset: Dataset, collectionId: string, id: string, change: { title?: string; hidden?: boolean }) {
    if (change.title !== undefined) change = { ...change, title: title(change.title) };
    return transaction(['collections', 'clips'], 'readwrite', async tx => {
      await collection(tx, dataset, collectionId);
      const clip = await request<VideoClip | undefined>(tx.objectStore('clips').get(id));
      if (!clip || clip.collectionId !== collectionId) throw new Error('Видео не найдено.');
      await request(tx.objectStore('clips').put({ ...clip, ...change }));
    });
  }
  async function addYouTube(dataset: Dataset, id: string, url: string, name: string) {
    const youtubeId = youtubeIdFromUrl(url), nameText = title(name);
    return transaction(['collections', 'clips'], 'readwrite', async tx => {
      await collection(tx, dataset, id);
      const clips = await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(id));
      const existing = clips.find(c => c.youtubeId === youtubeId);
      const order = Math.max(-1, ...clips.map(c => c.order)) + 1;
      if (existing) {
        // Re-adding puts it at the end, retaining its title, ID and daily marks.
        const value = { ...existing, hidden: false, order };
        await request(tx.objectStore('clips').put(value));
        return value;
      }
      const clip: VideoClip = { id: crypto.randomUUID(), collectionId: id, title: nameText, filename: '', source: `https://www.youtube.com/watch?v=${youtubeId}`, size: 0, modified: 0, type: 'youtube', order, hidden: false, youtubeId };
      await request(tx.objectStore('clips').add(clip));
      return clip;
    });
  }
  async function move(dataset: Dataset, collectionId: string, id: string, direction: -1 | 1) {
    return transaction(['collections', 'clips'], 'readwrite', async tx => {
      await collection(tx, dataset, collectionId);
      const clips = (await request<VideoClip[]>(tx.objectStore('clips').index('collection').getAll(collectionId))).filter(c => !c.hidden).sort((a, b) => a.order - b.order);
      const index = clips.findIndex(c => c.id === id), other = clips[index + direction];
      if (index < 0 || !other) return;
      [clips[index].order, other.order] = [other.order, clips[index].order];
      await Promise.all([request(tx.objectStore('clips').put(clips[index])), request(tx.objectStore('clips').put(other))]);
    });
  }
  async function mark(dataset: Dataset, collectionId: string, videoId: string, date: DateKey, completed: boolean) {
    if (!validDate(date)) throw new Error('Выберите действительную дату.');
    return transaction(['collections', 'clips', 'marks'], 'readwrite', async tx => {
      await collection(tx, dataset, collectionId);
      const clip = await request<VideoClip | undefined>(tx.objectStore('clips').get(videoId));
      if (!clip || clip.collectionId !== collectionId || clip.hidden) throw new Error('Видео не найдено в подборке.');
      const id = `${videoId}@${date}`;
      if (completed) await request(tx.objectStore('marks').put({ id, collectionId, videoId, date, completedAt: now().toISOString() } satisfies VideoMark));
      else await request(tx.objectStore('marks').delete(id));
    });
  }
  async function media(dataset: Dataset, collectionId: string, videoId: string): Promise<Blob> {
    return transaction(['collections', 'clips', 'media'], 'readonly', async tx => {
      await collection(tx, dataset, collectionId);
      const clip = await request<VideoClip | undefined>(tx.objectStore('clips').get(videoId));
      if (!clip || clip.collectionId !== collectionId) throw new Error('Видео не найдено.');
      const blob = await request<Blob | undefined>(tx.objectStore('media').get(videoId));
      if (!blob) throw new Error('Файл видео недоступен. Добавьте исходный файл ещё раз.');
      return blob;
    });
  }
  return { list, create, updateCollection, addFiles, addYouTube, updateClip, move, mark, media };
}
