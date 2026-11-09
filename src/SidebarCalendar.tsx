import { useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, formatDate, monthDays, monthStart, shiftMonth, validDate, weekday } from './domain';
import type { DateKey } from './domain';

const weekdays = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export default function SidebarCalendar({
  month,
  selectedDate,
  today,
  onMonthChange,
  onSelect,
}: {
  month: DateKey;
  selectedDate: DateKey;
  today: DateKey;
  onMonthChange: (month: DateKey) => void;
  onSelect: (date: DateKey) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const start = monthStart(month);
  const leading = weekday(start) - 1;
  const first = addDays(start, -leading);
  const cells = Math.ceil((leading + monthDays(start).length) / 7) * 7;
  const monthLabel = formatDate(start, { month: 'long', year: 'numeric' }).replace(' г.', '');
  function select(date: DateKey) {
    onSelect(date);
    setExpanded(false);
  }

  return (
    <section className={`panel sidebar-calendar${expanded ? ' expanded' : ''}`} aria-label="Мини-календарь">
      <button
        className="mini-calendar-toggle"
        aria-label={expanded ? 'Свернуть мини-календарь' : 'Показать мини-календарь'}
        aria-expanded={expanded}
        aria-controls="sidebar-calendar-content"
        onClick={() => setExpanded((value) => !value)}
      >
        <CalendarDays aria-hidden="true" />
        <span>{monthLabel}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      <div className="mini-calendar-content" id="sidebar-calendar-content">
        <div className="mini-calendar-heading">
          <button
            className="mini-calendar-arrow"
            aria-label="Предыдущий месяц мини-календаря"
            disabled={start <= '1900-01-01'}
            onClick={() => onMonthChange(shiftMonth(start, -1))}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <h2 aria-live="polite">{monthLabel}</h2>
          <button
            className="mini-calendar-arrow"
            aria-label="Следующий месяц мини-календаря"
            disabled={start >= '2199-12-01'}
            onClick={() => onMonthChange(shiftMonth(start, 1))}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="mini-calendar-weekdays" aria-hidden="true">
          {weekdays.map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="mini-calendar-days">
          {Array.from({ length: cells }, (_, index) => {
            const date = addDays(first, index);
            return (
              <button
                key={date}
                className={`mini-calendar-day${date === today ? ' today' : ''}${date === selectedDate ? ' selected' : ''}${monthStart(date) !== start ? ' outside' : ''}`}
                aria-label={`Открыть день: ${formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`}
                aria-pressed={date === selectedDate}
                aria-current={date === today ? 'date' : undefined}
                disabled={!validDate(date)}
                onClick={() => select(date)}
              >
                {Number(date.slice(-2))}
              </button>
            );
          })}
        </div>
        <button className="mini-calendar-today" onClick={() => select(today)}>
          Сегодня
        </button>
      </div>
    </section>
  );
}
