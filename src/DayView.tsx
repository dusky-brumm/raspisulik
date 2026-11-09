import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Film,
  ListTodo,
  TriangleAlert,
} from 'lucide-react';
import {
  addDays,
  clockTime,
  daySegments,
  duration,
  formatDate,
  goalFor,
  occurrences,
  todayInZone,
  weekday,
  zonedMinutes,
} from './domain';
import type { Activity, AppState, DateKey, DaySegment, Occurrence, Schedule } from './domain';
import { readPreference, writePreference } from './preferences';

const SCALE = 2;
const MODE_KEY = `raspisulik:ui:${import.meta.env.BASE_URL}:day-mode`;
const MODES = ['list', 'scale'] as const;
type Mode = (typeof MODES)[number];
const done = (state: AppState, occurrence: Occurrence) =>
  Boolean(state.completions.completed[occurrence.key]);
const endTime = (segment: DaySegment) => (segment.end === 1440 ? '24:00' : clockTime(segment.end));
function timeLabel(segment: DaySegment) {
  return `${clockTime(segment.start)}–${endTime(segment)}${segment.continues ? ' · со вчера' : ''}${segment.continuesAfter ? ' · далее завтра' : ''}`;
}

export default function DayView({
  schedule,
  state,
  day,
  today,
  setDay,
  openDay,
  taskRow,
  checkButton,
  onDetail,
  workoutActivities,
  onOpenWorkout,
}: {
  schedule: Schedule;
  state: AppState;
  day: DateKey;
  today: DateKey;
  setDay: (date: DateKey) => void;
  openDay: (date: DateKey) => void;
  taskRow: (occurrence: Occurrence, showDate?: boolean) => ReactNode;
  checkButton: (occurrence: Occurrence, small?: boolean) => ReactNode;
  onDetail: (activity: Activity, occurrence?: Occurrence) => void;
  workoutActivities: ReadonlySet<string>;
  onOpenWorkout: (activity: Activity, date: DateKey) => void;
}) {
  const [mode, setMode] = useState<Mode>(() => readPreference(MODE_KEY, MODES, 'list'));
  const [now, setNow] = useState(() => new Date());
  const grid = useRef<HTMLDivElement>(null);
  const agenda = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, []);
  useEffect(() => {
    writePreference(MODE_KEY, mode);
  }, [mode]);
  useEffect(() => {
    if (grid.current) grid.current.scrollTop = 0;
  }, [day]);

  const all = occurrences(schedule, day, day);
  const untimed = all.filter((occurrence) => !occurrence.activity.time);
  const segments = daySegments(schedule, day);
  const firstHour = Math.min(7, ...segments.map((segment) => Math.floor(segment.start / 60)));
  const lastHour = Math.max(22, ...segments.map((segment) => Math.ceil(segment.end / 60)));
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, index) => firstHour + index);
  const conflicts = segments.filter((segment) => segment.conflict).length;
  const monday = addDays(day, 1 - weekday(day));
  const dayItems = [...segments, ...untimed];
  const plannedMinutes =
    segments.reduce((total, segment) => total + segment.end - segment.start, 0) +
    untimed.reduce((total, occurrence) => total + occurrence.activity.durationMinutes, 0);
  const completed = dayItems.filter((occurrence) => done(state, occurrence)).length;
  const nowMinute = zonedMinutes(now);
  const isToday = day === todayInZone(now);
  const current = isToday
    ? segments.find((segment) => segment.start <= nowMinute && nowMinute < segment.end)
    : undefined;
  const nearest = current ?? (isToday ? segments.find((segment) => segment.start > nowMinute) : undefined);

  function jumpToNow() {
    if (mode === 'scale' && grid.current) {
      grid.current.scrollTop = Math.max(0, (nowMinute - firstHour * 60) * SCALE - 80);
    } else if (nearest) {
      const row = agenda.current?.querySelector<HTMLElement>(`[data-occurrence="${nearest.key}"]`);
      row?.scrollIntoView({ block: 'center', behavior: 'instant' });
      row?.querySelector<HTMLElement>('.agenda-description')?.focus({ preventScroll: true });
    }
  }

  return (
    <>
      <div className="day-toolbar">
        <div className="day-title">
          <button
            className="icon-button"
            aria-label="Предыдущий день"
            onClick={() => setDay(addDays(day, -1))}
          >
            <ChevronLeft />
          </button>
          <h2>
            {formatDate(day, { day: 'numeric', month: 'long' })}
            <small>{formatDate(day, { weekday: 'long', year: 'numeric' }).replace(' г.', '')}</small>
          </h2>
          <button className="icon-button" aria-label="Следующий день" onClick={() => setDay(addDays(day, 1))}>
            <ChevronRight />
          </button>
        </div>
        <div className="date-picker">
          <label>
            <CalendarDays />
            <input
              type="date"
              aria-label="Выбрать день"
              value={day}
              min="1900-01-02"
              max="2199-12-30"
              onChange={(event) => {
                if (event.target.validity.valid && event.target.value) openDay(event.target.value);
              }}
            />
          </label>
          <button className="today-button" onClick={() => setDay(today)}>
            Сегодня
          </button>
        </div>
      </div>
      <div className="week-strip" aria-label="Неделя">
        {Array.from({ length: 7 }, (_, index) => addDays(monday, index)).map((date) => (
          <button
            key={date}
            className={`${date === day ? 'selected' : ''} ${date === today ? 'is-today' : ''}`}
            aria-pressed={date === day}
            aria-label={formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}
            onClick={() => setDay(date)}
          >
            <span>{formatDate(date, { weekday: 'short' })}</span>
            <strong>{Number(date.slice(-2))}</strong>
            <i
              className={
                daySegments(schedule, date).length || occurrences(schedule, date, date).length
                  ? 'has-plans'
                  : ''
              }
            />
          </button>
        ))}
      </div>
      <div className="day-meta">
        <span>
          {dayItems.length}{' '}
          {dayItems.length % 10 === 1 && dayItems.length % 100 !== 11
            ? 'занятие'
            : [2, 3, 4].includes(dayItems.length % 10) && ![12, 13, 14].includes(dayItems.length % 100)
              ? 'занятия'
              : 'занятий'}{' '}
          · {duration(plannedMinutes)}
        </span>
        <span>
          {completed} / {dayItems.length} выполнено
        </span>
      </div>
      <div className="day-layout">
        <section className="panel day-grid-panel" aria-label="Занятия по времени">
          <div className="simple-panel-heading day-panel-heading">
            <h2>
              <Clock3 /> По времени
            </h2>
            <div className="day-view-actions">
              {isToday && (mode === 'scale' || nearest) && (
                <button className="text-button jump-now" onClick={jumpToNow}>
                  Сейчас
                </button>
              )}
              <div className="segmented-control" aria-label="Вид дня">
                {MODES.map((value) => (
                  <button
                    key={value}
                    className={mode === value ? 'active' : ''}
                    aria-pressed={mode === value}
                    onClick={() => setMode(value)}
                  >
                    {value === 'list' ? 'Список' : 'Шкала'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {conflicts > 0 && (
            <div className="conflict-note">
              <TriangleAlert /> Пересечения по времени: {conflicts}
            </div>
          )}
          {mode === 'list' ? (
            <div className="day-agenda" ref={agenda}>
              {segments.length === 0 && <p className="small-empty">Нет занятий по времени</p>}
              {segments.map((segment) => {
                const goal = goalFor(schedule, segment.activity);
                return (
                  <div
                    key={segment.key}
                    data-occurrence={segment.key}
                    className={`agenda-row color-${goal?.color ?? 'lavender'} ${done(state, segment) ? 'is-done' : ''} ${current?.key === segment.key ? 'agenda-current' : ''}`}
                    aria-current={current?.key === segment.key ? 'time' : undefined}
                  >
                    <span className="agenda-time">
                      {clockTime(segment.start)}
                      <small>{endTime(segment)}</small>
                    </span>
                    <button
                      className="agenda-description"
                      onClick={() => onDetail(segment.activity, segment)}
                    >
                      <span className="task-title">{segment.activity.title}</span>
                      <span className="task-meta">
                        {segment.continues ? 'Со вчера · ' : ''}
                        {duration(segment.end - segment.start)}
                        {segment.continuesAfter ? ' · далее завтра' : ''}
                        {current?.key === segment.key ? ' · сейчас' : ''}
                        {segment.conflict ? ' · пересечение' : ''}
                      </span>
                    </button>
                    {workoutActivities.has(segment.activity.id) && (
                      <button
                        className="icon-button agenda-workout"
                        title="Открыть тренировку"
                        aria-label={`Открыть шаги: ${segment.activity.title}`}
                        onClick={() => onOpenWorkout(segment.activity, segment.date)}
                      >
                        <Film />
                      </button>
                    )}
                    {checkButton(segment)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              className="day-grid-scroll"
              ref={grid}
              tabIndex={0}
              aria-label="Шкала времени, прокрутка по вертикали"
            >
              <div className="day-grid" style={{ height: `${(lastHour - firstHour) * 60 * SCALE}px` }}>
                {hours.map((hour) => (
                  <div
                    className="hour-line"
                    key={hour}
                    style={{ top: `${(hour - firstHour) * 60 * SCALE}px` }}
                  >
                    <span>{String(hour).padStart(2, '0')}:00</span>
                  </div>
                ))}
                <div className="day-events">
                  {segments.map((segment) => {
                    const height = (segment.end - segment.start) * SCALE - 2;
                    const style = {
                      top: `${(segment.start - firstHour * 60) * SCALE}px`,
                      height: `${Math.max(2, height)}px`,
                      left: `calc(${(segment.column / segment.columns) * 100}% + 4px)`,
                      width: `calc(${100 / segment.columns}% - 8px)`,
                    };
                    return (
                      <div
                        key={segment.key}
                        className={`day-event color-${goalFor(schedule, segment.activity)?.color ?? 'lavender'} ${done(state, segment) ? 'event-done' : ''} ${height < 40 ? 'short-event' : ''}`}
                        style={style}
                      >
                        <button
                          className="event-body"
                          onClick={() => onDetail(segment.activity, segment)}
                          aria-label={`${segment.activity.title}, ${timeLabel(segment)}`}
                          title={`${segment.activity.title}: ${timeLabel(segment)}`}
                        >
                          <strong>
                            {segment.continues && <ArrowDownLeft />}
                            {segment.activity.title}
                          </strong>
                          {height >= 40 && (
                            <small>
                              {timeLabel(segment)}
                              {segment.conflict && <TriangleAlert />}
                            </small>
                          )}
                        </button>
                        {height >= 44 && checkButton(segment, true)}
                      </div>
                    );
                  })}
                  {isToday && nowMinute >= firstHour * 60 && nowMinute <= lastHour * 60 && (
                    <div className="now-line" style={{ top: `${(nowMinute - firstHour * 60) * SCALE}px` }}>
                      <span>{clockTime(nowMinute)}</span>
                    </div>
                  )}
                  {segments.length === 0 && (
                    <div className="day-grid-empty">
                      <p>Нет занятий по времени</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
        {untimed.length > 0 && (
          <div className="day-aside">
            <section className="panel untimed-panel">
              <div className="simple-panel-heading">
                <h2>
                  <ListTodo /> Без времени
                </h2>
              </div>
              {untimed.map((occurrence) => taskRow(occurrence))}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
