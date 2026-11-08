import { useCallback, useEffect, useRef, useState } from 'react';
import { AlignLeft, ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, ExternalLink, Film, FolderOpen, Link, LoaderCircle, Pencil, Play, Plus, RotateCcw, Upload, X } from 'lucide-react';
import { addDays, formatDate, validDate } from './domain';
import type { Dataset, DateKey, Schedule } from './domain';
import { createVideoStore, videoProgress } from './video-store';
import type { ExerciseInput, VideoClip, VideoCollection, VideoLibrary as Library } from './video-store';

const store = createVideoStore({ name: `raspisulik:videos:${import.meta.env.BASE_URL}` });
const empty = (): Library => ({ collections: [], clips: [], marks: [] });
function errorText(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Недостаточно места в браузере. Добавьте меньше роликов. Уже сохранённые видео остались на месте.';
  return error instanceof Error ? error.message : 'Не удалось сохранить изменения.';
}
type Draft = { id?: string; title: string; activityId: string };

export default function VideoLibrary({ dataset, schedule, date, today, setDate, focusActivity, onProgress }: {
  dataset: Dataset; schedule: Schedule; date: DateKey; today: DateKey; setDate: (date: DateKey) => void;
  focusActivity?: string; onProgress: (activityId: string, date: DateKey, allDone: boolean) => Promise<void>;
}) {
  const [library, setLibrary] = useState<Library>(empty);
  const [selectedId, setSelectedId] = useState('');
  const [playingId, setPlayingId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [linkDraft, setLinkDraft] = useState<{ url: string; title: string } | null>(null);
  const [exerciseDraft, setExerciseDraft] = useState<(ExerciseInput & { id?: string }) | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [notice, setNotice] = useState('');
  const saving = useRef(false);
  const loadVersion = useRef(0);
  const contextKey = `${dataset}:${date}:${focusActivity ?? ''}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const files = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null);
  const selected = library.collections.find(c => c.id === selectedId);
  const clips = library.clips.filter(c => c.collectionId === selectedId && !c.hidden);
  const hidden = library.clips.filter(c => c.collectionId === selectedId && c.hidden);
  const playing = clips.find(c => c.id === playingId);
  const doneIds = new Set(library.marks.filter(m => m.date === date).map(m => m.videoId));
  const progress = videoProgress(library.clips, library.marks, selectedId, date);
  const linked = schedule.activities.find(a => a.id === selected?.activityId);

  const reload = useCallback(async (preferred?: string) => {
    const version = currentContext.current === contextKey ? ++loadVersion.current : -1;
    const result = await store.list(dataset, date);
    if (version === loadVersion.current && currentContext.current === contextKey) {
      setLibrary(result);
      setSelectedId(current => preferred ?? (result.collections.some(c => c.id === current) ? current : focusActivity ? result.collections.find(c => c.activityId === focusActivity)?.id ?? '' : result.collections[0]?.id ?? ''));
    }
    return result;
  }, [dataset, date, focusActivity, contextKey]);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(''); setSyncError(''); setNotice(''); setPlayingId('');
    void reload().catch(e => { if (alive) setError(errorText(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; ++loadVersion.current; };
  }, [reload]);
  useEffect(() => {
    // Directory selection is progressive enhancement; ordinary files always remain available.
    if (folder.current) folder.current.webkitdirectory = true;
  }, [selectedId]);
  useEffect(() => { setPlayingId(''); setEditing(false); setDraft(null); setLinkDraft(null); setExerciseDraft(null); setNotice(''); }, [selectedId]);

  async function run(operation: () => Promise<void>) {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (navigator.locks) await navigator.locks.request(`raspisulik:video-writes:${import.meta.env.BASE_URL}`, operation);
      else await operation();
    } catch (e) { setError(errorText(e)); }
    finally { saving.current = false; setBusy(false); }
  }
  async function sync(result: Library, collection: VideoCollection) {
    const p = videoProgress(result.clips, result.marks, collection.id, date);
    if (!collection.activityId || !p.total) return;
    try { await onProgress(collection.activityId, date, p.allDone); setSyncError(''); }
    catch (e) { setSyncError(`Отметки шагов сохранены. Не удалось обновить задачу: ${errorText(e)}`); }
  }
  async function importFiles(selectedFiles: File[]) {
    if (!selected) return;
    await run(async () => {
      const result = await store.addFiles(dataset, selected.id, selectedFiles);
      const updated = await reload(selected.id);
      await sync(updated, selected);
      setNotice(`Добавлено: ${result.added}${result.restored ? ` · возвращено: ${result.restored}` : ''}${result.skipped ? ` · пропущено: ${result.skipped}` : ''}`);
      // Request durable storage only after a successful, user-initiated import.
      void navigator.storage?.persist?.().catch(() => {});
    });
  }
  async function mark(clip: VideoClip, completed: boolean, next = false) {
    if (!selected) return;
    await run(async () => {
      await store.mark(dataset, selected.id, clip.id, date, completed);
      const updated = await reload(selected.id);
      await sync(updated, selected);
      if (next && currentContext.current === contextKey) setPlayingId(clips[clips.findIndex(c => c.id === clip.id) + 1]?.id ?? clip.id);
    });
  }
  function newDraft() {
    const activity = schedule.activities.find(a => a.id === focusActivity);
    setDraft({ title: activity?.title ?? '', activityId: activity?.id ?? '' });
  }
  async function saveDraft() {
    if (!draft) return;
    await run(async () => {
      const item = draft.id
        ? await store.updateCollection(dataset, draft.id, draft.title, draft.activityId || undefined)
        : await store.create(dataset, draft.title, draft.activityId || undefined);
      await reload(item.id); setDraft(null);
    });
  }
  async function saveLink() {
    if (!selected || !linkDraft) return;
    await run(async () => {
      await store.addYouTube(dataset, selected.id, linkDraft.url, linkDraft.title);
      await sync(await reload(selected.id), selected);
      setLinkDraft(null); setNotice('Ролик добавлен в конец подборки.');
    });
  }
  async function saveExercise() {
    if (!selected || !exerciseDraft) return;
    await run(async () => {
      await store.saveExercise(dataset, selected.id, exerciseDraft, exerciseDraft.id);
      await sync(await reload(selected.id), selected);
      setExerciseDraft(null); setNotice('Упражнение сохранено.');
    });
  }
  return <section className="video-library" aria-label="Шаги тренировки" aria-busy={busy || loading}>
    {library.collections.length > 0 && <div className="video-topbar">
      <label className="video-collection-select"><span className="sr-only">Подборка</span><select aria-label="Подборка" value={selectedId} disabled={busy} onChange={e => { setSelectedId(e.target.value); setSyncError(''); setError(''); }}>{!selectedId && <option value="">Для занятия пока нет подборки</option>}{library.collections.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
      {!draft && selected && <button className="text-button" disabled={busy} onClick={newDraft}><Plus /> Новая подборка</button>}
      {selected && <button className="icon-button" aria-label={editing ? 'Закончить редактирование видео' : 'Редактировать подборку'} title="Редактировать подборку" disabled={busy} onClick={() => { setEditing(v => !v); setDraft(null); }}><Pencil /></button>}
    </div>}
    {draft && <form className="panel video-form" onSubmit={e => { e.preventDefault(); void saveDraft(); }}>
      <label>Название<input autoFocus required maxLength={180} placeholder="Например, Зарядка" value={draft.title} disabled={busy} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      <label>Задача в расписании<select aria-label="Задача для новой подборки" disabled={busy} value={draft.activityId} onChange={e => setDraft({ ...draft, activityId: e.target.value })}><option value="">Без привязки</option>{schedule.activities.map(a => <option key={a.id} value={a.id} disabled={library.collections.some(c => c.activityId === a.id && c.id !== draft.id)}>{a.title}</option>)}</select></label>
      <div className="video-form-actions"><button className="text-button" type="button" disabled={busy} onClick={() => setDraft(null)}>Отмена</button><button className="primary-button" disabled={busy || !draft.title.trim()}>{draft.id ? 'Сохранить' : 'Создать подборку'}</button></div>
    </form>}
    {error && <div className="backup-error" role="alert">{error}<button className="text-button" onClick={() => void run(async () => { await reload(); })}>Обновить список</button></div>}
    {syncError && <div className="backup-error" role="alert">{syncError}<button className="text-button" disabled={busy} onClick={() => selected && void run(async () => { await sync(await reload(), selected); })}>Повторить отметку задачи</button></div>}
    {notice && <p className="video-notice" role="status">{notice}</p>}
    {loading ? <div className="small-empty" role="status">Загружаем тренировку…</div> : !selected ? !draft && <div className="panel video-empty"><Film /><h2>{focusActivity ? schedule.activities.find(a => a.id === focusActivity)?.title ?? 'Соберите свою тренировку' : 'Соберите свою тренировку'}</h2><p>Создайте подборку и добавьте видео или упражнения с инструкциями.</p><button className="primary-button" onClick={newDraft}><Plus /> Новая подборка</button></div> : <>
      {editing && !draft && <div className="video-edit-heading"><button className="text-button" disabled={busy} onClick={() => setDraft({ id: selected.id, title: selected.title, activityId: selected.activityId ?? '' })}><Pencil /> Название и связь с задачей</button></div>}
      <div className="video-datebar"><div className="video-date-nav"><button className="icon-button" aria-label="Предыдущий день тренировки" disabled={busy || date <= '1900-01-01'} onClick={() => setDate(addDays(date, -1))}><ChevronLeft /></button><input type="date" aria-label="Дата выполнения тренировки" min="1900-01-01" max="2199-12-31" disabled={busy} value={date} onChange={e => { if (validDate(e.target.value)) setDate(e.target.value); }} /><button className="icon-button" aria-label="Следующий день тренировки" disabled={busy || date >= '2199-12-31'} onClick={() => setDate(addDays(date, 1))}><ChevronRight /></button>{date !== today && <button className="text-button" disabled={busy} onClick={() => setDate(today)}>Сегодня</button>}</div><span aria-label="Выполнение тренировки">{progress.completed} / {progress.total} выполнено</span></div>
      {selected.activityId && <p className="video-linked">{linked ? <>Задача: {linked.title}</> : 'Связанной задачи больше нет в расписании'}</p>}
      {playing && <VideoPlayer key={playing.id} dataset={dataset} clip={playing} done={doneIds.has(playing.id)} busy={busy} hasNext={clips.findIndex(c => c.id === playing.id) < clips.length - 1} onComplete={() => void mark(playing, true, true)} />}
      <div className="panel video-playlist">
        {!clips.length && <div className="video-empty"><Film /><h2>Добавьте шаги</h2><p>Видео из файлов, ссылка YouTube или упражнение с инструкцией.</p></div>}
        <ol>{clips.map((clip, index) => <li key={clip.id} className={`${doneIds.has(clip.id) ? 'video-done' : ''} ${playingId === clip.id ? 'video-selected' : ''}`}>
          <button className={`completion ${doneIds.has(clip.id) ? 'checked' : ''}`} disabled={busy} aria-pressed={doneIds.has(clip.id)} aria-label={`${doneIds.has(clip.id) ? 'Снять отметку шага' : 'Выполнить шаг'}: ${clip.title}, ${formatDate(date)}`} onClick={() => void mark(clip, !doneIds.has(clip.id))}>{doneIds.has(clip.id) && <Check />}</button>
          {editing ? <div className="video-row-edit">
            <ClipName clip={clip} busy={busy} onSave={name => void run(async () => { await store.updateClip(dataset, selectedId, clip.id, { title: name }); await reload(); })} />
            <small>{clip.exercise?.repetitions ?? clip.source}</small>
            <div className="video-row-actions">
              {clip.exercise && <button className="text-button" disabled={busy} aria-label={`Изменить инструкцию: ${clip.title}`} onClick={() => setExerciseDraft({ id: clip.id, title: clip.title, ...clip.exercise! })}><Pencil /> Инструкция</button>}
              <button className="icon-button" aria-label={`Выше: ${clip.title}`} disabled={busy || index === 0} onClick={() => void run(async () => { await store.move(dataset, selectedId, clip.id, -1); await reload(); })}><ArrowUp /></button>
              <button className="icon-button" aria-label={`Ниже: ${clip.title}`} disabled={busy || index === clips.length - 1} onClick={() => void run(async () => { await store.move(dataset, selectedId, clip.id, 1); await reload(); })}><ArrowDown /></button>
              <button className="text-button" disabled={busy} onClick={() => void run(async () => { await store.updateClip(dataset, selectedId, clip.id, { hidden: true }); await sync(await reload(), selected); })}><X /> Убрать</button>
            </div>
          </div> : <button className="video-open" aria-label={`${clip.exercise ? 'Открыть упражнение' : 'Смотреть'}: ${clip.title}`} onClick={() => setPlayingId(clip.id)}>
            <span className="video-position">{index + 1}</span><span className="video-open-label"><strong>{clip.title}</strong>{clip.exercise && <small>{clip.exercise.repetitions}</small>}</span>{clip.exercise ? <AlignLeft /> : <Play />}
          </button>}
        </li>)}</ol>
        <div className="video-import-actions"><button className="secondary-button" disabled={busy} onClick={() => files.current?.click()}>{busy ? <LoaderCircle className="spin" /> : <Upload />} Файлы</button><button className="secondary-button" disabled={busy} onClick={() => folder.current?.click()}><FolderOpen /> Папка</button><button className="secondary-button" disabled={busy} onClick={() => { setExerciseDraft(null); setLinkDraft({ url: '', title: '' }); }}><Link /> YouTube</button><button className="secondary-button" disabled={busy} onClick={() => { setLinkDraft(null); setExerciseDraft({ title: '', repetitions: '', instructions: '', sourceUrl: '' }); }}><Plus /> Упражнение</button></div>
      </div>
      {exerciseDraft && <form className="panel video-form video-link-form" onSubmit={e => { e.preventDefault(); void saveExercise(); }}>
        <label>Название упражнения<input autoFocus required maxLength={180} value={exerciseDraft.title} disabled={busy} onChange={e => setExerciseDraft({ ...exerciseDraft, title: e.target.value })} /></label>
        <label>Повторы или длительность<input required maxLength={180} placeholder="Например, по 5 раз на сторону" value={exerciseDraft.repetitions} disabled={busy} onChange={e => setExerciseDraft({ ...exerciseDraft, repetitions: e.target.value })} /></label>
        <label>Как выполнять<textarea required maxLength={4000} rows={5} value={exerciseDraft.instructions} disabled={busy} onChange={e => setExerciseDraft({ ...exerciseDraft, instructions: e.target.value })} /></label>
        <label>Источник (необязательно)<input type="url" value={exerciseDraft.sourceUrl ?? ''} disabled={busy} onChange={e => setExerciseDraft({ ...exerciseDraft, sourceUrl: e.target.value })} /></label>
        <div className="video-form-actions"><button className="text-button" type="button" disabled={busy} onClick={() => setExerciseDraft(null)}>Отмена</button><button className="primary-button" disabled={busy || !exerciseDraft.title.trim() || !exerciseDraft.repetitions.trim() || !exerciseDraft.instructions.trim()}>{exerciseDraft.id ? 'Сохранить упражнение' : 'Добавить упражнение'}</button></div>
      </form>}
      {linkDraft && <form className="panel video-form video-link-form" onSubmit={e => { e.preventDefault(); void saveLink(); }}><label>Ссылка YouTube<input autoFocus type="url" required aria-label="Ссылка YouTube" placeholder="https://www.youtube.com/watch?v=…" value={linkDraft.url} disabled={busy} onChange={e => setLinkDraft({ ...linkDraft, url: e.target.value })} /></label><label>Название ролика<input required maxLength={180} value={linkDraft.title} disabled={busy} onChange={e => setLinkDraft({ ...linkDraft, title: e.target.value })} /></label><div className="video-form-actions"><button className="text-button" type="button" disabled={busy} onClick={() => setLinkDraft(null)}>Отмена</button><button className="primary-button" disabled={busy || !linkDraft.url.trim() || !linkDraft.title.trim()}>Добавить в конец</button></div></form>}
      {editing && hidden.length > 0 && <details className="video-hidden"><summary>Убранные видео ({hidden.length})</summary>{hidden.map(clip => <div key={clip.id}><span>{clip.title}</span><button className="text-button" disabled={busy} onClick={() => void run(async () => { await store.updateClip(dataset, selectedId, clip.id, { hidden: false }); await sync(await reload(), selected); })}><RotateCcw /> Вернуть</button></div>)}</details>}
      <p className="hint-text video-storage-note">Подборки, файлы и отметки остаются в этом браузере. Для YouTube нужен интернет. Экспорт расписания не содержит подборки.</p>
    </>}
    <input ref={files} type="file" multiple accept="video/*,.mp4,.m4v,.webm,.mov,.ogv,.ogg,.mkv,.avi" className="file-input" aria-label="Видео из файлов" onChange={e => { const value = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; if (value.length) void importFiles(value); }} />
    <input ref={folder} type="file" multiple className="file-input" aria-label="Папка с видео" onChange={e => { const value = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; if (value.length) void importFiles(value); }} />
  </section>;
}

function ClipName({ clip, busy, onSave }: { clip: VideoClip; busy: boolean; onSave: (title: string) => void }) {
  const [name, setName] = useState(clip.title);
  useEffect(() => { setName(clip.title); }, [clip.title]);
  return <form className="video-rename" onSubmit={e => { e.preventDefault(); onSave(name); }}><input aria-label={`Название видео: ${clip.title}`} value={name} maxLength={180} required disabled={busy} onChange={e => setName(e.target.value)} /><button className="icon-button" aria-label={`Сохранить название: ${clip.title}`} disabled={busy || !name.trim() || name.trim() === clip.title}><Check /></button></form>;
}

function VideoPlayer({ dataset, clip, done, busy, hasNext, onComplete }: { dataset: Dataset; clip: VideoClip; done: boolean; busy: boolean; hasNext: boolean; onComplete: () => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    if (clip.youtubeId || clip.exercise) return;
    let active = true, objectUrl = '';
    void store.media(dataset, clip.collectionId, clip.id).then(blob => {
      if (active) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [dataset, clip.id, clip.collectionId, clip.youtubeId, clip.exercise]);
  const youtube = clip.youtubeId && /^[a-zA-Z0-9_-]{11}$/.test(clip.youtubeId) ? clip.youtubeId : undefined;
  return <div className={`panel video-player ${clip.exercise ? 'exercise-card' : ''}`}>
    {clip.exercise ? <article className="exercise-instructions"><h2>{clip.title}</h2><p className="exercise-repetitions">{clip.exercise.repetitions}</p><p>{clip.exercise.instructions}</p>{clip.exercise.sourceUrl && <a className="text-button" href={clip.exercise.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink /> Источник · {clip.exercise.sourceUrl.replace(/^https:\/\/(www\.)?/, '').split('/')[0]}</a>}</article> : youtube ? <iframe src={`https://www.youtube-nocookie.com/embed/${youtube}?rel=0&playsinline=1`} title={`Видео: ${clip.title}`} referrerPolicy="strict-origin-when-cross-origin" allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen /> : url ? <video controls playsInline preload="metadata" src={url} aria-label={`Видео: ${clip.title}`} onError={() => setError('Браузер не смог воспроизвести этот формат. Попробуйте MP4 с H.264 или WebM.')} /> : <p role="status">Открываем видео…</p>}
    {youtube && <a className="text-button video-youtube-link" href={`https://www.youtube.com/watch?v=${youtube}`} target="_blank" rel="noreferrer"><ExternalLink /> Открыть на YouTube</a>}
    {error && <p className="backup-error" role="alert">{error}{url && <a className="text-button" href={url} download={clip.filename}>Скачать исходный файл</a>}</p>}
    <div className="video-player-footer">{!clip.exercise && <span>{clip.title}</span>}<button className="primary-button" disabled={busy || (done && !hasNext)} onClick={onComplete}><Check />{done ? hasNext ? 'Дальше' : 'Выполнено' : hasNext ? 'Выполнено и дальше' : 'Выполнено'}</button></div>
  </div>;
}
