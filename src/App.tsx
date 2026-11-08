import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlignLeft, ArrowDownLeft, ArrowLeft, CalendarDays, Check, Folders,
  ChevronLeft, ChevronRight, CircleHelp, Clock3, Film,
  Download, ListTodo, LoaderCircle, RefreshCw, Save, Search, Upload,
  Sunrise, TriangleAlert, X,
} from 'lucide-react';
import {
  activitiesForGroup, addDays, challengeProgress, clockTime, daySegments, duration, formatDate, goalFor, groupTypeLabel, monthDays,
  monthStart, occurrenceKey, occurrences, occursOn, periodLabel, recurrenceLabel,
  organizeActivities, shiftMonth, todayInZone, UNGROUPED_ID, weekday,
} from './domain';
import type { Activity, AppState, Challenge, Color, Dataset, DateKey, Goal, Occurrence, Schedule } from './domain';
import { dataClient } from './data-client';
import VideoLibrary from './VideoLibrary';

type View = 'timeline' | 'day' | 'calendar' | 'goals' | 'tasks' | 'videos';
const nav: { id: View; title: string; icon: typeof Folders }[] = [
  { id: 'timeline', title: 'Таймлайн', icon: AlignLeft },
  { id: 'day', title: 'День', icon: Sunrise },
  { id: 'calendar', title: 'Календарь', icon: CalendarDays },
  { id: 'goals', title: 'Группы', icon: Folders },
  { id: 'tasks', title: 'Задачи', icon: ListTodo },
  { id: 'videos', title: 'Видео', icon: Film },
];
const headings: Record<View, string> = {
  timeline: 'Расписание',
  day: 'День',
  calendar: 'Календарь',
  goals: 'Группы',
  tasks: 'Задачи',
  videos: 'Видео',
};
function plural(n: number, words: [string, string, string]): string {
  return `${n} ${n % 100 >= 11 && n % 100 <= 14 ? words[2] : n % 10 === 1 ? words[0] : n % 10 >= 2 && n % 10 <= 4 ? words[1] : words[2]}`;
}
function getDataset(): Dataset {
  try {
    const value = localStorage.getItem('raspisulik.dataset');
    if (value === 'personal' || value === 'demo') return value;
  } catch { /* Keep the app readable when preferences cannot be stored. */ }
  return dataClient.browser ? 'personal' : 'demo';
}
function isDone(state: AppState, o: Occurrence): boolean { return Boolean(state.completions.completed[o.key]); }
function colorOf(schedule: Schedule, a: Activity): Color { return goalFor(schedule, a)?.color ?? 'lavender'; }
function GoalSymbol({ goal, small = false }: { goal?: Goal; small?: boolean }) {
  return <span aria-hidden="true" className={`goal-symbol color-${goal?.color ?? 'lavender'} ${small ? 'small' : ''}`}><span /></span>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    function keydown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
      <div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={20} /></button></div>
      {children}
    </div>
  </div>;
}

export default function App() {
  const [view, setView] = useState<View>('timeline');
  const [dataset, setDataset] = useState<Dataset>(getDataset);
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState('');
  const [month, setMonth] = useState(() => monthStart(todayInZone()));
  const [day, setDay] = useState(todayInZone);
  const [goalId, setGoalId] = useState('all');
  const [detail, setDetail] = useState<{ activity: Activity; occurrence?: Occurrence } | null>(null);
  const [help, setHelp] = useState(false);
  const [videoActivity, setVideoActivity] = useState<string>();
  const [backup, setBackup] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const modeRef = useRef(dataset);
  const savingRef = useRef(false);
  modeRef.current = dataset;

  useEffect(() => { window.scrollTo({ top: 0, left: 0 }); }, [view, dataset]);

  const refresh = useCallback(async () => {
    if (savingRef.current) return;
    const token = ++request.current;
    setLoading(true);
    try {
      const result = await dataClient.load(dataset);
      if (token !== request.current || modeRef.current !== dataset) return;
      setState(result); setError('');
    } catch (e) {
      if (token === request.current && modeRef.current === dataset) setError(e instanceof Error ? e.message : 'Нет связи с локальным приложением.');
    } finally { if (token === request.current) setLoading(false); }
  }, [dataset]);
  useEffect(() => {
    setState(null); setGoalId('all'); setDetail(null); setError('');
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { ++request.current; window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  useEffect(() => {
    if (!state || goalId === 'all') return;
    const exists = goalId === UNGROUPED_ID
      ? state.schedule.activities.some(a => !a.goalId)
      : state.schedule.goals.some(g => g.id === goalId);
    if (!exists) setGoalId('all');
  }, [state, goalId]);

  function changeDataset(value: Dataset) {
    setDataset(value);
    try { localStorage.setItem('raspisulik.dataset', value); } catch { /* The dataset choice is optional. */ }
  }
  async function toggle(o: Occurrence) {
    if (!state || savingRef.current) return;
    const expectedDataset = dataset;
    savingRef.current = true; setBusyKey(o.key);
    ++request.current; // A refresh started before this write must not restore stale marks.
    try {
      const completions = await dataClient.setCompleted(dataset, { activityId: o.activity.id, date: o.date, completed: !isDone(state, o) });
      if (modeRef.current === expectedDataset) { setState(prev => prev ? { ...prev, completions } : prev); setError(''); }
    } catch (e) { if (modeRef.current === expectedDataset) setError(e instanceof Error ? e.message : 'Не удалось сохранить отметку.'); }
    finally { savingRef.current = false; setBusyKey(''); setLoading(false); }
  }
  const closeDetail = useCallback(() => setDetail(null), []);
  const closeHelp = useCallback(() => setHelp(false), []);
  const closeBackup = useCallback(() => { if (!savingRef.current) setBackup(false); }, []);
  const today = state?.today ?? todayInZone();
  const previousToday = useRef(today);
  useEffect(() => {
    const before = previousToday.current;
    if (before === today) return;
    setDay(value => value === before ? today : value);
    setMonth(value => value === monthStart(before) ? monthStart(today) : value);
    previousToday.current = today;
  }, [today]);
  const schedule = state?.schedule;
  const filtered = useMemo(() => schedule ? { ...schedule, activities: activitiesForGroup(schedule, goalId) } : null, [schedule, goalId]);
  const selectedGroup = schedule?.goals.find(g => g.id === goalId);
  const pageTitle = view === 'goals' && goalId !== 'all' ? selectedGroup?.title ?? 'Без группы' : headings[view];

  function openDay(value: DateKey) { setDay(value); setMonth(monthStart(value)); setView('day'); }
  function goToday() { setDay(today); setMonth(monthStart(today)); }
  function detailOf(activity: Activity, occurrence?: Occurrence) { setDetail({ activity, occurrence }); }
  function openGroup(id: string) { setGoalId(id); setView('goals'); }
  function openVideos(activity: Activity, date: DateKey) { setVideoActivity(activity.id); setDay(date); setDetail(null); setView('videos'); }
  async function videoCompletion(activityId: string, date: DateKey, completed: boolean) {
    const activity = schedule?.activities.find(a => a.id === activityId);
    if (!activity || !occursOn(activity, date)) return;
    if (savingRef.current) throw new Error('Дождитесь сохранения другой отметки и повторите.');
    const expectedDataset = dataset;
    savingRef.current = true; ++request.current;
    try {
      const completions = await dataClient.setCompleted(dataset, { activityId, date, completed });
      if (modeRef.current === expectedDataset) setState(prev => prev ? { ...prev, completions } : prev);
    } finally { savingRef.current = false; setLoading(false); }
  }
  async function exportBackup() {
    try {
      const text = await dataClient.exportPersonal();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `raspisulik-${today}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupError('');
    } catch (e) { setBackupError(e instanceof Error ? e.message : 'Не удалось экспортировать данные.'); }
  }
  async function importBackup(file: File) {
    if (savingRef.current) return;
    savingRef.current = true; setImporting(true); setBackupError(''); ++request.current;
    try {
      if (file.size > 2_000_000) throw new Error('Выберите JSON-файл размером до 2 МБ.');
      await dataClient.importPersonal(await file.text());
      savingRef.current = false;
      if (dataset === 'personal') await refresh();
      else changeDataset('personal');
      setBackup(false);
    } catch (e) { setBackupError(e instanceof Error ? e.message : 'Не удалось импортировать расписание.'); }
    finally { savingRef.current = false; setImporting(false); setLoading(false); }
  }
  function checkButton(o: Occurrence, small = false) {
    if (!state) return null;
    const done = isDone(state, o);
    return <button className={`completion ${done ? 'checked' : ''} ${small ? 'compact' : ''}`} disabled={Boolean(busyKey)}
      aria-label={`${done ? 'Снять отметку' : 'Выполнить'}: ${o.activity.title}, ${formatDate(o.date)}`}
      aria-pressed={done} onClick={() => void toggle(o)}>
      {busyKey === o.key ? <LoaderCircle size={14} className="spin" /> : done ? <Check size={14} strokeWidth={2.5} /> : null}
    </button>;
  }
  function taskRow(o: Occurrence, showDate = false) {
    if (!state || !schedule) return null;
    const goal = goalFor(schedule, o.activity), done = isDone(state, o);
    return <div className={`task-row ${done ? 'is-done' : ''}`} key={o.key}>
      {checkButton(o)}
      <button className="task-description" onClick={() => detailOf(o.activity, o)}>
        <span className="task-title">{o.activity.title}</span>
        <span className="task-meta">{showDate && `${formatDate(o.date, { day: 'numeric', month: 'short' })} · `}{o.activity.time ?? 'Без времени'}<span>·</span>{duration(o.activity.durationMinutes)}</span>
      </button>
      {goal && <span className={`goal-tag color-${goal.color}`}>{goalId === goal.id ? o.activity.section : goal.title}</span>}
    </div>;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView('timeline'); }} aria-label="Расписулик — таймлайн">
        <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
        <span>расписулик</span>
      </a>
      <nav aria-label="Основная навигация">{nav.map(({ id, title, icon: Icon }) => <button key={id} className={`nav-item ${view === id ? 'active' : ''}`} onClick={() => { setView(id); if (id === 'goals') setGoalId('all'); if (id === 'videos') setVideoActivity(undefined); }} aria-current={view === id ? 'page' : undefined}>
        <Icon size={22} strokeWidth={1.5} /><span>{title}</span>
      </button>)}</nav>
      <div className="sidebar-bottom"><button className="help-button" aria-label="Добавить через чат" title="Добавить через чат" onClick={() => setHelp(true)}><CircleHelp size={22} /> Как добавить</button></div>
    </aside>

    <main className="main">
      <div className="page-content">
        <header className="page-heading"><h1>{pageTitle}</h1><div className="heading-actions"><label className="dataset-select"><select aria-label="Набор данных" value={dataset} disabled={Boolean(busyKey) || importing} onChange={e => changeDataset(e.target.value as Dataset)}><option value="demo">Демо</option><option value="personal">Мои планы</option></select></label>{dataClient.browser && <button className="icon-button refresh-button" aria-label="Импорт и экспорт" title="Импорт и экспорт" disabled={Boolean(busyKey) || importing} onClick={() => { setBackupError(''); setBackup(true); }}><Save size={22} /></button>}<button className="icon-button refresh-button" title="Обновить расписание" aria-label="Обновить расписание" onClick={() => void refresh()} disabled={loading || Boolean(busyKey) || importing}><RefreshCw size={22} className={loading ? 'spin' : ''} /></button></div></header>

        {error && <div className="error-banner" role="alert"><TriangleAlert size={18} /><div><strong>Не удалось обновить данные</strong><p>{error}</p><small>{state ? 'Последнее загруженное расписание сохранено на экране. ' : ''}Исправьте файл или проверьте, запущено ли приложение.</small></div><button className="text-button" onClick={() => void refresh()}>Повторить</button></div>}
        {!state ? <div className="loading-state" role="status">{loading ? <><LoaderCircle className="spin" />Загружаем расписание…</> : <><CalendarDays />Расписание пока недоступно. Попробуйте обновить данные.</>}</div> : <>
          <ChallengeStatus challenge={schedule!.challenge} today={today} onToday={() => openDay(today)} />
          {view !== 'goals' && view !== 'videos' && schedule!.goals.length > 0 && <div className="goal-filters" aria-label="Фильтр по группе"><button className={goalId === 'all' ? 'selected' : ''} aria-pressed={goalId === 'all'} onClick={() => setGoalId('all')}>Все группы</button>{schedule!.goals.map(goal => <button key={goal.id} className={goalId === goal.id ? 'selected' : ''} aria-pressed={goalId === goal.id} onClick={() => setGoalId(goal.id)}><span className={`dot color-${goal.color}`} />{goal.title}</button>)}{schedule!.activities.some(a => !a.goalId) && <button className={goalId === UNGROUPED_ID ? 'selected' : ''} aria-pressed={goalId === UNGROUPED_ID} onClick={() => setGoalId(UNGROUPED_ID)}>Без группы</button>}</div>}

          {view === 'videos' ? <VideoLibrary key={`${dataset}:${videoActivity ?? 'library'}`} dataset={dataset} schedule={schedule!} date={day} today={today} setDate={setDay} focusActivity={videoActivity} onProgress={videoCompletion} /> : schedule!.activities.length === 0 && (view !== 'goals' || schedule!.goals.length === 0) ? <EmptyPersonal /> : filtered && <>
            {view === 'timeline' && <>
              <section className="panel timeline-panel" aria-label="Месячный таймлайн"><div className="panel-toolbar"><MonthNavigation month={month} setMonth={setMonth} onToday={goToday} /></div>
                <Timeline schedule={filtered} state={state} month={month} today={today} openDay={openDay} onDetail={detailOf} showGroupNames={goalId === 'all'} onGroup={openGroup} />
              </section>
            </>}
            {view === 'day' && <DayView schedule={filtered} state={state} day={day} today={today} setDay={value => { setDay(value); setMonth(monthStart(value)); }} openDay={openDay} taskRow={taskRow} checkButton={checkButton} onDetail={detailOf} />}
            {view === 'calendar' && <CalendarView schedule={filtered} state={state} month={month} today={today} setMonth={setMonth} onToday={goToday} openDay={openDay} />}
            {view === 'goals' && <GroupsView schedule={schedule!} state={state} goalId={goalId} setGoalId={setGoalId} month={month} setMonth={setMonth} onToday={goToday} onDetail={detailOf} openDay={openDay} />}
            {view === 'tasks' && <TasksView schedule={filtered} state={state} today={today} taskRow={taskRow} />}
          </>}
        </>}
      </div>
    </main>
    {detail && schedule && state && <Modal title={detail.activity.title} onClose={closeDetail}>
      <div className="detail-goal"><GoalSymbol goal={goalFor(schedule, detail.activity)} small /><span>{goalFor(schedule, detail.activity)?.title ?? 'Без группы'}{detail.activity.section && <> / {detail.activity.section}</>}</span><span className="kind-tag">{{ habit: 'Привычка', task: 'Задача', event: 'Событие' }[detail.activity.kind]}</span></div>
      <dl className="detail-list"><div><dt>Когда</dt><dd>{detail.occurrence ? formatDate(detail.occurrence.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : periodLabel(detail.activity)}</dd></div><div><dt>Время</dt><dd>{detail.activity.time ?? 'Без точного времени'} · {duration(detail.activity.durationMinutes)}</dd></div><div><dt>Повторение</dt><dd>{recurrenceLabel(detail.activity)}</dd></div>{detail.occurrence && <div><dt>Период</dt><dd>{periodLabel(detail.activity)}</dd></div>}{Boolean(detail.activity.excludedDates?.length) && <div><dt>Исключения</dt><dd>{detail.activity.excludedDates!.map(d => formatDate(d)).join(', ')}</dd></div>}</dl>
      {detail.activity.notes && <div className="detail-note"><span>Заметка</span><p>{detail.activity.notes}</p></div>}
      <button className="secondary-button detail-videos" onClick={() => openVideos(detail.activity, detail.occurrence?.date ?? today)}><Film /> Видео для занятия <ChevronRight /></button>
      {detail.occurrence ? <button className={`primary-button detail-complete ${isDone(state, detail.occurrence) ? 'done-button' : ''}`} disabled={Boolean(busyKey)} onClick={() => void toggle(detail.occurrence!)}>{busyKey === detail.occurrence.key ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}{isDone(state, detail.occurrence) ? 'Выполнено · снять отметку' : 'Отметить выполненным'}<span>{formatDate(detail.occurrence.date, { day: 'numeric', month: 'short' })}</span></button> : <p className="hint-text">Чтобы отметить выполнение, откройте нужный день занятия.</p>}
    </Modal>}
    {help && <Modal title="Добавить через чат" onClose={closeHelp}><p className="help-intro">Назовите цель, проблему или проект, затем связанные задачи. Внутри группы можно выделить разделы. Для расписания укажите даты, повторение и длительность.</p><blockquote>«В цель “Привести себя в форму”, в раздел “Движение”, добавь прогулку через день на 30 минут с 9 ноября»</blockquote><button className="primary-button" onClick={closeHelp}>Понятно</button></Modal>}
    {backup && <Modal title="Расписание и отметки" onClose={closeBackup}>
      <p className="help-intro">Данные хранятся в этом браузере. Файл позволяет перенести их на другое устройство.</p>
      <p className="hint-text">Импорт расписания сохраняет отметки. Резервная копия восстанавливает расписание и отметки из файла.</p>
      <p className="hint-text">Видеоподборки и отметки роликов хранятся отдельно и не входят в этот JSON.</p>
      {backupError && <p className="backup-error" role="alert">{backupError}</p>}
      <div className="backup-actions"><button className="secondary-button" disabled={importing} onClick={() => void exportBackup()}><Download size={22} /> Экспорт</button><button className="primary-button" disabled={importing} onClick={() => importInput.current?.click()}>{importing ? <LoaderCircle className="spin" size={22} /> : <Upload size={22} />} Импорт</button></div>
      <input ref={importInput} type="file" accept=".json,application/json" className="file-input" aria-label="Файл расписания" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void importBackup(file); }} />
    </Modal>}
  </div>;
}

function ChallengeStatus({ challenge, today, onToday }: { challenge?: Challenge; today: DateKey; onToday: () => void }) {
  const progress = challenge ? challengeProgress(challenge, today) : undefined;
  const text = !challenge || !progress ? '' : progress.status === 'upcoming' ? `Старт ${formatDate(challenge.startDate)}` : progress.status === 'finished' ? 'Челлендж завершён' : `День ${progress.day} из ${challenge.durationDays}`;
  return <div className="challenge-status" aria-label="Сегодня и челлендж"><button onClick={onToday}>Сегодня, {formatDate(today)}</button>{challenge && progress && <><span className="challenge-day" title={challenge.title}>{text}</span><span className="challenge-range">{formatDate(challenge.startDate, { day: 'numeric', month: 'short' })} — {formatDate(progress.endDate, { day: 'numeric', month: 'short' })}</span></>}</div>;
}

function SmallEmpty({ text }: { text: string }) { return <div className="small-empty"><p>{text}</p></div>; }
function EmptyPersonal() {
  return <section className="panel empty-personal"><h2>Пока нет планов</h2></section>;
}
function MonthNavigation({ month, setMonth, onToday }: { month: DateKey; setMonth: (d: DateKey) => void; onToday: () => void }) {
  return <div className="month-navigation"><button className="icon-button" aria-label="Предыдущий месяц" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={18} /></button><span>{formatDate(month, { month: 'long', year: 'numeric' }).replace(' г.', '')}</span><button className="icon-button" aria-label="Следующий месяц" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={18} /></button><button className="today-button" onClick={onToday}>Сегодня</button></div>;
}

function Timeline({ schedule, state, month, today, openDay, onDetail, showGroupNames = true, onGroup }: {
  schedule: Schedule; state: AppState; month: DateKey; today: DateKey;
  openDay: (d: DateKey) => void; onDetail: (a: Activity, o?: Occurrence) => void;
  showGroupNames?: boolean; onGroup: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const days = monthDays(month);
  const rows = schedule.activities.filter(a => a.startDate <= days.at(-1)! && (!a.endDate || a.endDate >= days[0]) && (a.recurrence.type !== 'once' || a.startDate >= days[0]));
  const organized = organizeActivities({ ...schedule, activities: rows });
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
    const cell = scroller.querySelector<HTMLElement>('thead .today-column');
    const label = scroller.querySelector<HTMLElement>('.activity-column');
    if (!cell || !label) { scroller.scrollLeft = 0; return; }
    const available = scroller.clientWidth - label.offsetWidth;
    scroller.scrollLeft = Math.max(0, cell.offsetLeft - label.offsetWidth - (available - cell.offsetWidth) / 2);
  }, [month, today, rows.length]);
  return <>
    {rows.length ? <div ref={scrollRef} className="timeline-scroll" tabIndex={0} role="region" aria-label="Таймлайн месяца. Прокрутите вправо, если не видны все дни."><table className="timeline-table"><colgroup><col className="activity-col" />{days.map(date => <col key={date} className="date-col" />)}</colgroup><thead><tr><th className="activity-column"><span>Занятия</span></th>{days.map(date => <th key={date} className={`${weekday(date) > 5 ? 'weekend' : ''} ${date === today ? 'today-column' : ''}`}><button onClick={() => openDay(date)} title={formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} aria-label={`Открыть ${formatDate(date)}`}><small>{formatDate(date, { weekday: 'short' })}</small><span className={date === today ? 'today-number' : ''}>{Number(date.slice(-2))}</span></button></th>)}</tr></thead><tbody>{organized.map((group, groupIndex) => <Fragment key={group.goal?.id ?? `ungrouped-${groupIndex}`}>
      {showGroupNames && <tr className="timeline-group-row"><th className="activity-column" scope="rowgroup"><button className="timeline-group-name" aria-label={`Открыть группу ${group.goal?.title ?? 'Без группы'}`} onClick={() => onGroup(group.goal?.id ?? UNGROUPED_ID)}><GoalSymbol goal={group.goal} small /><span>{group.goal?.title ?? 'Без группы'}</span></button></th><td colSpan={days.length}>{group.goal && <span className="group-type">{groupTypeLabel(group.goal)}</span>}</td></tr>}
      {group.sections.map((section, sectionIndex) => <Fragment key={sectionIndex}>
        {(section.title || group.sections.some(s => s.title)) && <tr className="timeline-section-row"><th className="activity-column" scope="rowgroup"><span>{section.title ?? 'Общее'}</span></th><td colSpan={days.length} /></tr>}
        {section.activities.map(activity => {
      const goal = goalFor(schedule, activity), color = goal?.color ?? 'lavender';
      return <tr key={activity.id} className={`timeline-row color-${color}`}><th scope="row" className="activity-column"><button className="activity-label" onClick={() => onDetail(activity)}><GoalSymbol goal={goal} small /><span><strong>{activity.title}</strong><small>{activity.time ? `${activity.time} · ` : ''}{duration(activity.durationMinutes)}<span className="label-dot">·</span>{recurrenceLabel(activity)}</small></span></button></th>{days.map(date => {
        const occurrence = occursOn(activity, date);
        const inPeriod = activity.recurrence.type !== 'once' && date >= activity.startDate && (!activity.endDate || date <= activity.endDate);
        const done = Boolean(state.completions.completed[occurrenceKey(activity.id, date)]);
        return <td key={date} className={`${weekday(date) > 5 ? 'weekend' : ''} ${date === today ? 'today-column' : ''}`}>
          {inPeriod && <span className={`period-band ${date === activity.startDate || date === days[0] ? 'band-start' : ''} ${date === activity.endDate || date === days.at(-1) ? 'band-end' : ''}`} />}
          {occurrence && <button className={`occurrence-marker ${done ? 'completed-marker' : ''}`} title={`${activity.title} · ${formatDate(date)} · ${activity.time ?? 'без времени'}${done ? ' · выполнено' : ''}`} aria-label={`${activity.title}, ${formatDate(date)}${done ? ', выполнено' : ''}`} onClick={() => onDetail(activity, { activity, date, key: occurrenceKey(activity.id, date) })}>{done ? <Check size={12} strokeWidth={2.7} /> : <span />}</button>}
        </td>;
      })}</tr>;
        })}
      </Fragment>)}
    </Fragment>)}</tbody></table></div> : <SmallEmpty text="В этом месяце нет занятий" />}
    <div className="timeline-footer"><div className="legend"><span><i className="legend-period" /> Период</span><span><i className="legend-occurrence" /> Занятие</span><span><i className="legend-done"><Check size={10} /></i> Выполнено</span></div></div>
  </>;
}

function DayView({ schedule, state, day, today, setDay, openDay, taskRow, checkButton, onDetail }: {
  schedule: Schedule; state: AppState; day: DateKey; today: DateKey; setDay: (d: DateKey) => void; openDay: (d: DateKey) => void;
  taskRow: (o: Occurrence, showDate?: boolean) => ReactNode; checkButton: (o: Occurrence, small?: boolean) => ReactNode; onDetail: (a: Activity, o?: Occurrence) => void;
}) {
  const all = occurrences(schedule, day, day), untimed = all.filter(o => !o.activity.time), segments = daySegments(schedule, day);
  const firstHour = Math.min(7, ...segments.map(s => Math.floor(s.start / 60)));
  const lastHour = Math.max(22, ...segments.map(s => Math.ceil(s.end / 60)));
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);
  const conflicts = segments.filter(s => s.conflict).length;
  const monday = addDays(day, 1 - weekday(day));
  const usedMinutes = segments.reduce((n, s) => n + s.end - s.start, 0);
  const dayItems = [...segments, ...untimed];
  const plannedMinutes = usedMinutes + untimed.reduce((n, o) => n + o.activity.durationMinutes, 0);
  const completed = dayItems.filter(o => isDone(state, o)).length;
  return <>
    <div className="day-toolbar"><div className="day-title"><button className="icon-button" aria-label="Предыдущий день" onClick={() => setDay(addDays(day, -1))}><ChevronLeft size={19} /></button><h2>{formatDate(day, { day: 'numeric', month: 'long' })}<small>{formatDate(day, { weekday: 'long', year: 'numeric' }).replace(' г.', '')}</small></h2><button className="icon-button" aria-label="Следующий день" onClick={() => setDay(addDays(day, 1))}><ChevronRight size={19} /></button></div><div className="date-picker"><label><CalendarDays size={15} /><input type="date" aria-label="Выбрать день" value={day} min="1900-01-02" max="2199-12-30" onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) openDay(e.target.value); }} /></label><button className="today-button" onClick={() => setDay(today)}>Сегодня</button></div></div>
    <div className="week-strip">{Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map(date => <button key={date} className={`${date === day ? 'selected' : ''} ${date === today ? 'is-today' : ''}`} onClick={() => setDay(date)}><span>{formatDate(date, { weekday: 'short' })}</span><strong>{Number(date.slice(-2))}</strong><i className={occurrences(schedule, date, date).length ? 'has-plans' : ''} /></button>)}</div>
    <div className="day-meta"><span>{plural(dayItems.length, ['занятие', 'занятия', 'занятий'])} · {duration(plannedMinutes)}</span><span>{completed} / {dayItems.length} выполнено</span></div>
    <div className="day-layout"><section className="panel day-grid-panel"><div className="simple-panel-heading"><h2><Clock3 size={22} /> По времени</h2></div>{conflicts > 0 && <div className="conflict-note"><TriangleAlert size={15} /> {plural(conflicts, ['занятие пересекается', 'занятия пересекаются', 'занятий пересекаются'])} по времени</div>}
      <div className="day-grid-scroll"><div className="day-grid" style={{ height: `${(lastHour - firstHour) * 66}px` }}>{hours.map(h => <div className="hour-line" key={h} style={{ top: `${(h - firstHour) * 66}px` }}><span>{String(h).padStart(2, '0')}:00</span></div>)}<div className="day-events">{segments.map(s => {
        const height = (s.end - s.start) * 1.1;
        const style = { top: `${(s.start - firstHour * 60) * 1.1}px`, height: `${Math.max(16, height)}px`, left: `calc(${s.column / s.columns * 100}% + 3px)`, width: `calc(${100 / s.columns}% - 9px)` };
        return <div key={s.key} className={`day-event color-${colorOf(schedule, s.activity)} ${isDone(state, s) ? 'event-done' : ''} ${height < 32 ? 'short-event' : ''}`} style={style}>
          <button className="event-body" onClick={() => onDetail(s.activity, s)} title={`${s.activity.title}: ${clockTime(s.start)}–${s.end === 1440 ? '24:00' : clockTime(s.end)}${s.continues ? ' (продолжение)' : ''}`}><strong>{s.continues && <ArrowDownLeft size={12} />}{s.activity.title}</strong>{height >= 32 && <small>{clockTime(s.start)}–{s.end === 1440 ? '24:00' : clockTime(s.end)}{s.continuesAfter ? ' · далее завтра' : ''}{s.continues ? ' · со вчера' : ''}{s.conflict && <TriangleAlert size={11} />}</small>}</button>{height >= 24 && checkButton(s, true)}</div>;
      })}{segments.length === 0 && <div className="day-grid-empty"><p>Нет занятий по времени</p></div>}</div></div></div>
    </section>{untimed.length > 0 && <div className="day-aside"><section className="panel untimed-panel"><div className="simple-panel-heading"><h2><ListTodo size={22} /> Без времени</h2></div>{untimed.map(o => taskRow(o))}</section></div>}</div>
  </>;
}

function CalendarView({ schedule, state, month, today, setMonth, onToday, openDay }: { schedule: Schedule; state: AppState; month: DateKey; today: DateKey; setMonth: (d: DateKey) => void; onToday: () => void; openDay: (d: DateKey) => void }) {
  const first = addDays(monthStart(month), 1 - weekday(monthStart(month)));
  const days = monthDays(month), length = Math.ceil((days.length + weekday(days[0]) - 1) / 7) * 7;
  return <section className="panel calendar-panel" aria-label="Календарь месяца"><div className="panel-toolbar"><MonthNavigation month={month} setMonth={setMonth} onToday={onToday} /></div><div className="calendar-weekdays">{['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'].map(d => <span key={d}><span>{d}</span><small>{d.slice(0, 2)}</small></span>)}</div><div className="calendar-grid">{Array.from({ length }, (_, i) => addDays(first, i)).map(date => {
    const items = occurrences(schedule, date, date), outside = date.slice(0, 7) !== month.slice(0, 7);
    return <button key={date} className={`calendar-cell ${outside ? 'outside-month' : ''} ${date === today ? 'calendar-today' : ''} ${weekday(date) > 5 ? 'calendar-weekend' : ''}`} onClick={() => openDay(date)} aria-label={`${formatDate(date)}, ${plural(items.length, ['занятие', 'занятия', 'занятий'])}`}><span className="calendar-date">{Number(date.slice(-2))}{date === today && <small>сегодня</small>}</span><div className="calendar-items">{items.slice(0, 3).map(o => <span key={o.key} className={`calendar-item color-${colorOf(schedule, o.activity)} ${isDone(state, o) ? 'done' : ''}`}>{isDone(state, o) ? <Check size={10} /> : <i />}{o.activity.time && <small>{o.activity.time}</small>}<span>{o.activity.title}</span></span>)}{items.length > 3 && <span className="calendar-more">ещё {items.length - 3}</span>}</div><span className="mobile-calendar-dots">{items.slice(0, 4).map(o => <i key={o.key} className={`dot color-${colorOf(schedule, o.activity)}`} />)}</span></button>;
  })}</div></section>;
}

function GroupsView({ schedule, state, goalId, setGoalId, month, setMonth, onToday, onDetail, openDay }: {
  schedule: Schedule; state: AppState; goalId: string; setGoalId: (id: string) => void;
  month: DateKey; setMonth: (d: DateKey) => void; onToday: () => void;
  onDetail: (a: Activity, o?: Occurrence) => void; openDay: (d: DateKey) => void;
}) {
  const [mode, setMode] = useState<'tasks' | 'timeline'>('tasks');
  useEffect(() => { setMode('tasks'); }, [goalId]);
  const goal = schedule.goals.find(g => g.id === goalId);
  const activities = activitiesForGroup(schedule, goalId);
  const grouped = { ...schedule, activities };

  function groupCard(item?: Goal) {
    const id = item?.id ?? UNGROUPED_ID;
    const tasks = activitiesForGroup(schedule, id);
    const sections = new Set(tasks.map(a => a.section?.trim()).filter(Boolean));
    return <button key={id} className={`goal-card color-${item?.color ?? 'lavender'}`} onClick={() => setGoalId(id)} aria-label={`Открыть группу ${item?.title ?? 'Без группы'}`}>
      <div className="goal-card-top"><GoalSymbol goal={item} /><span className="group-type">{item ? groupTypeLabel(item) : 'Задачи'}</span><ChevronRight size={22} /></div>
      <h2>{item?.title ?? 'Без группы'}</h2>
      {item?.description && <p>{item.description}</p>}
      <div className="goal-card-summary"><span>{plural(tasks.length, ['задача', 'задачи', 'задач'])}</span>{sections.size > 0 && <span>{plural(sections.size, ['раздел', 'раздела', 'разделов'])}</span>}</div>
    </button>;
  }

  if (goalId === 'all') return <div className="goals-overview">
    {schedule.goals.map(g => groupCard(g))}
    {schedule.activities.some(a => !a.goalId) && groupCard()}
  </div>;

  return <>
    <div className="group-context"><button className="text-button" onClick={() => setGoalId('all')}><ArrowLeft size={22} /> Все группы</button>{goal && <span className="group-type">{groupTypeLabel(goal)}</span>}</div>
    {goal?.description && <p className="group-description">{goal.description}</p>}
    <section className="panel group-detail" aria-label={`Содержимое группы ${goal?.title ?? 'Без группы'}`}>
      <div className="panel-toolbar"><div className="tabs" aria-label="Вид группы">
        <button className={mode === 'tasks' ? 'selected' : ''} aria-pressed={mode === 'tasks'} onClick={() => setMode('tasks')}>Задачи</button>
        <button className={mode === 'timeline' ? 'selected' : ''} aria-pressed={mode === 'timeline'} onClick={() => setMode('timeline')}>Таймлайн</button>
      </div>{mode === 'timeline' && <MonthNavigation month={month} setMonth={setMonth} onToday={onToday} />}</div>
      {mode === 'timeline' ? <Timeline schedule={grouped} state={state} month={month} today={state.today} openDay={openDay} onDetail={onDetail} showGroupNames={false} onGroup={setGoalId} /> :
        activities.length === 0 ? <SmallEmpty text="В этой группе пока нет задач" /> :
        organizeActivities(grouped).map((group, i) => <div className="group-task-sections" key={i}>{group.sections.map((section, sectionIndex) => <section className="group-task-section" key={sectionIndex}>
          {(section.title || group.sections.some(s => s.title)) && <h2>{section.title ?? 'Общее'}</h2>}
          {section.activities.map(a => <button className="group-activity" key={a.id} onClick={() => onDetail(a)}>
            <div><strong>{a.title}</strong><span>{recurrenceLabel(a)} · {a.time ?? 'Без времени'} · {duration(a.durationMinutes)}</span><small>{periodLabel(a)}</small></div><ChevronRight size={22} />
          </button>)}
        </section>)}</div>)}
    </section>
  </>;
}

function TasksView({ schedule, state, today, taskRow }: { schedule: Schedule; state: AppState; today: DateKey; taskRow: (o: Occurrence, showDate?: boolean) => ReactNode }) {
  const [tab, setTab] = useState('upcoming');
  const [query, setQuery] = useState('');
  const from = addDays(today, -7), to = addDays(today, 30);
  const recent = occurrences(schedule, from, to);
  for (const a of schedule.activities) {
    if (a.recurrence.type === 'once' && a.startDate < from && occursOn(a, a.startDate)) recent.push({ activity: a, date: a.startDate, key: occurrenceKey(a.id, a.startDate) });
  }
  // Older completed occurrences stay available in the completed tab.
  const known = new Set(recent.map(o => o.key));
  if (tab === 'done') for (const key of Object.keys(state.completions.completed)) {
    if (known.has(key)) continue;
    const [id, date] = key.split('@'), a = schedule.activities.find(item => item.id === id);
    if (a && occursOn(a, date)) recent.push({ activity: a, date, key });
  }
  const normalized = query.trim().toLocaleLowerCase('ru');
  const items = recent.filter(o => {
    const done = isDone(state, o);
    if (tab === 'done' ? !done : done || (tab === 'today' && o.date !== today)) return false;
    return `${o.activity.title} ${o.activity.notes ?? ''} ${o.activity.section ?? ''} ${goalFor(schedule, o.activity)?.title ?? ''}`.toLocaleLowerCase('ru').includes(normalized);
  }).sort((a, b) => (tab === 'done' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date)) || (a.activity.time ?? '99').localeCompare(b.activity.time ?? '99'));
  const groups = new Map<string, Occurrence[]>();
  for (const o of items) groups.set(o.date, [...(groups.get(o.date) ?? []), o]);
  return <section className="panel tasks-panel"><div className="tasks-toolbar"><div className="tabs" aria-label="Состояние задач">{[['upcoming', 'Ближайшие'], ['today', 'Сегодня'], ['done', 'Выполненные']].map(([id, label]) => <button key={id} className={id === tab ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}</div><label className="search-input"><Search size={22} /><input placeholder="Поиск" aria-label="Поиск задач" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={22} /></button>}</label></div>{[...groups].map(([date, list]) => <div className="task-group" key={date}><h3>{date === today ? 'Сегодня' : date === addDays(today, 1) ? 'Завтра' : formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}{date < today && tab !== 'done' && <span className="overdue-label">Просрочено</span>}</h3>{list.map(o => taskRow(o))}</div>)}{items.length === 0 && <SmallEmpty text={query ? 'Ничего не найдено' : tab === 'done' ? 'Пока нет выполненных занятий' : 'Нет задач'} />}</section>;
}
