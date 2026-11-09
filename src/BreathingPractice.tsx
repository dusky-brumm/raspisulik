import { useEffect, useReducer, useRef, useState } from 'react';
import { Check, ExternalLink, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import {
  BREATHING_PROGRAMS,
  breathingClock,
  breathingFrame,
  breathingReducer,
  createBreathingSession,
} from './breathing';
import type { BreathingProgramId } from './breathing';
import { readPreference, writePreference } from './preferences';

const PREFIX = `raspisulik:ui:${import.meta.env.BASE_URL}:breathing:`;
const SECONDS = ['2', '3', '4', '5', '6', '7', '8'] as const;
const DURATIONS = ['1', '3', '5', '10'] as const;
function initialSettings() {
  const programId = readPreference<BreathingProgramId>(
    `${PREFIX}program`,
    ['diaphragm', 'antistress'],
    'diaphragm',
  );
  const program = BREATHING_PROGRAMS.find((item) => item.id === programId)!;
  return {
    programId,
    durationMinutes: Number(readPreference(`${PREFIX}duration`, DURATIONS, '5')),
    inhaleSeconds: Number(
      readPreference(
        `${PREFIX}${programId}:inhale`,
        SECONDS,
        String(program.inhaleSeconds) as (typeof SECONDS)[number],
      ),
    ),
    exhaleSeconds: Number(
      readPreference(
        `${PREFIX}${programId}:exhale`,
        SECONDS,
        String(program.exhaleSeconds) as (typeof SECONDS)[number],
      ),
    ),
  };
}

export default function BreathingPractice({ active }: { active: boolean }) {
  const [settings, setSettings] = useState(initialSettings);
  const [session, dispatch] = useReducer(
    breathingReducer,
    settings.durationMinutes * 60_000,
    createBreathingSession,
  );
  const [now, setNow] = useState(() => performance.now());
  const [sound, setSound] = useState(() => readPreference(`${PREFIX}sound`, ['off', 'on'], 'off') === 'on');
  const [soundError, setSoundError] = useState('');
  const [audioReady, setAudioReady] = useState(0);
  const [pauseReason, setPauseReason] = useState('');
  const audio = useRef<AudioContext | null>(null);
  const panel = useRef<HTMLElement>(null);
  const lastCue = useRef('');
  const program = BREATHING_PROGRAMS.find((item) => item.id === settings.programId)!;
  const frame = breathingFrame(session, settings, now);
  const locked = session.status === 'running' || session.status === 'paused';

  useEffect(() => {
    writePreference(`${PREFIX}program`, settings.programId);
    writePreference(`${PREFIX}duration`, String(settings.durationMinutes));
    writePreference(`${PREFIX}${settings.programId}:inhale`, String(settings.inhaleSeconds));
    writePreference(`${PREFIX}${settings.programId}:exhale`, String(settings.exhaleSeconds));
  }, [settings]);
  useEffect(() => {
    writePreference(`${PREFIX}sound`, sound ? 'on' : 'off');
  }, [sound]);
  useEffect(
    () => () => {
      void audio.current?.close().catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (session.status !== 'running') return;
    const timer = window.setInterval(() => {
      const tick = performance.now();
      setNow(tick);
      dispatch({ type: 'tick', now: tick });
    }, 100);
    return () => window.clearInterval(timer);
  }, [session.status]);
  useEffect(() => {
    const pause = () => {
      if (document.hidden) {
        dispatch({ type: 'pause', now: performance.now() });
        setPauseReason('Вкладка была скрыта');
      }
    };
    document.addEventListener('visibilitychange', pause);
    return () => document.removeEventListener('visibilitychange', pause);
  }, []);
  useEffect(() => {
    if (!active) dispatch({ type: 'pause', now: performance.now() });
  }, [active]);

  function cue(phase: 'inhale' | 'exhale') {
    const context = audio.current;
    if (!sound || !context || context.state !== 'running') return false;
    const oscillator = context.createOscillator(),
      gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = phase === 'inhale' ? 440 : 330;
    gain.gain.setValueAtTime(0, context.currentTime);
    gain.gain.linearRampToValueAtTime(0.06, context.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.24);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    return true;
  }
  useEffect(() => {
    if (
      !active ||
      document.hidden ||
      session.status !== 'running' ||
      frame.finished ||
      lastCue.current === frame.phaseKey
    )
      return;
    if (cue(frame.phase)) lastCue.current = frame.phaseKey;
  }, [active, session.status, frame.phaseKey, frame.finished, sound, audioReady]);

  async function prepareSound() {
    if (!sound) return;
    try {
      if (!audio.current) audio.current = new AudioContext();
      await audio.current.resume();
      setAudioReady((value) => value + 1);
      setSoundError('');
    } catch {
      setSoundError('Звук недоступен. Визуальные подсказки продолжают работать.');
    }
  }
  function start() {
    void prepareSound();
    const tick = performance.now();
    setNow(tick);
    setPauseReason('');
    lastCue.current = '';
    if (session.status === 'finished')
      dispatch({ type: 'reset', totalMs: settings.durationMinutes * 60_000 });
    dispatch({ type: 'start', now: tick });
    panel.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  function reset() {
    dispatch({ type: 'reset', totalMs: settings.durationMinutes * 60_000 });
    setNow(performance.now());
    setPauseReason('');
    lastCue.current = '';
  }
  function selectProgram(programId: BreathingProgramId) {
    if (locked) return;
    const next = BREATHING_PROGRAMS.find((item) => item.id === programId)!;
    setSettings((current) => ({
      ...current,
      programId,
      inhaleSeconds: Number(
        readPreference(
          `${PREFIX}${programId}:inhale`,
          SECONDS,
          String(next.inhaleSeconds) as (typeof SECONDS)[number],
        ),
      ),
      exhaleSeconds: Number(
        readPreference(
          `${PREFIX}${programId}:exhale`,
          SECONDS,
          String(next.exhaleSeconds) as (typeof SECONDS)[number],
        ),
      ),
    }));
    reset();
  }
  const phaseLabel =
    session.status === 'finished'
      ? 'Готово'
      : session.status === 'paused'
        ? 'Пауза'
        : frame.phase === 'inhale'
          ? 'Вдох'
          : 'Выдох';

  return (
    <section className="breathing" aria-label="Дыхательные практики">
      <div className="breathing-programs" role="group" aria-label="Программа дыхания">
        {BREATHING_PROGRAMS.map((item) => (
          <button
            key={item.id}
            className={`panel breathing-program ${settings.programId === item.id ? 'selected' : ''}`}
            disabled={locked}
            aria-pressed={settings.programId === item.id}
            onClick={() => selectProgram(item.id)}
          >
            <strong>{item.title}</strong>
            <span>{item.description}</span>
          </button>
        ))}
      </div>
      <section ref={panel} className="panel breathing-session" aria-label={`Практика: ${program.title}`}>
        <div className="breathing-toolbar">
          <label>
            Длительность
            <select
              aria-label="Длительность дыхательной практики"
              value={settings.durationMinutes}
              disabled={locked}
              onChange={(event) => {
                const durationMinutes = Number(event.target.value);
                setSettings((current) => ({ ...current, durationMinutes }));
                dispatch({ type: 'reset', totalMs: durationMinutes * 60_000 });
              }}
            >
              {DURATIONS.map((value) => (
                <option key={value} value={value}>
                  {value} мин
                </option>
              ))}
            </select>
          </label>
          <button
            className="text-button breathing-sound"
            aria-label="Звуковые подсказки"
            aria-pressed={sound}
            onClick={() => {
              setSound((value) => !value);
              setSoundError('');
              if (!sound) {
                try {
                  if (!audio.current) audio.current = new AudioContext();
                  void audio.current
                    .resume()
                    .then(() => setAudioReady((value) => value + 1))
                    .catch(() => setSoundError('Звук недоступен'));
                } catch {
                  setSoundError('Звук недоступен');
                }
              }
            }}
          >
            {sound ? <Volume2 /> : <VolumeX />} Звук {sound ? 'вкл' : 'выкл'}
          </button>
        </div>
        <p className="breathing-rhythm">
          Вдох {settings.inhaleSeconds} с <span>·</span> Выдох {settings.exhaleSeconds} с <span>·</span> Без
          задержек
        </p>
        <div className="breathing-guide">
          <div
            className="breathing-ring"
            aria-hidden="true"
            style={{ transform: `scale(${0.72 + frame.expansion * 0.28})` }}
          />
          <div className="breathing-guide-label">
            <span role="status" aria-live="polite">
              {phaseLabel}
            </span>
            <strong
              aria-label={
                session.status === 'finished'
                  ? 'Практика завершена'
                  : `Секунд до смены фазы: ${frame.phaseSeconds}`
              }
            >
              {session.status === 'finished' ? <Check /> : frame.phaseSeconds}
            </strong>
            {session.status === 'paused' && <small>{frame.phase === 'inhale' ? 'Вдох' : 'Выдох'}</small>}
          </div>
        </div>
        <div className="breathing-remaining">
          <span>{breathingClock(frame.remainingSeconds)}</span>
          <small>{session.status === 'finished' ? 'Практика завершена' : 'осталось'}</small>
        </div>
        <div className="breathing-controls">
          {session.status === 'running' ? (
            <button
              className="primary-button"
              onClick={() => {
                const tick = performance.now();
                setNow(tick);
                dispatch({ type: 'pause', now: tick });
                setPauseReason('');
              }}
            >
              <Pause /> Пауза
            </button>
          ) : (
            <button className="primary-button" onClick={start}>
              {session.status === 'finished' ? <RotateCcw /> : <Play />}
              {session.status === 'finished'
                ? 'Ещё раз'
                : session.status === 'paused'
                  ? 'Продолжить'
                  : 'Начать'}
            </button>
          )}
          {session.status !== 'idle' && (
            <button className="secondary-button" onClick={reset}>
              <RotateCcw /> Сбросить
            </button>
          )}
        </div>
        {session.status === 'paused' && pauseReason && (
          <p className="breathing-pause-note" role="status">
            {pauseReason} · продолжите, когда будете готовы
          </p>
        )}
        {soundError && (
          <p className="breathing-pause-note" role="status">
            {soundError}
          </p>
        )}
      </section>
      <details className="breathing-details">
        <summary>Как выполнять и настроить ритм</summary>
        <p>{program.instructions}</p>
        <div className="breathing-settings">
          {(['inhaleSeconds', 'exhaleSeconds'] as const).map((key) => (
            <label key={key}>
              {key === 'inhaleSeconds' ? 'Вдох' : 'Выдох'}
              <select
                aria-label={key === 'inhaleSeconds' ? 'Секунд на вдох' : 'Секунд на выдох'}
                disabled={locked}
                value={settings[key]}
                onChange={(event) => {
                  setSettings((current) => ({ ...current, [key]: Number(event.target.value) }));
                  reset();
                }}
              >
                {SECONDS.map((value) => (
                  <option key={value} value={value}>
                    {value} с
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p>Подберите комфортный счёт. Ритмы таймера — настраиваемые ориентиры.</p>
        <a className="text-button" href={program.source} target="_blank" rel="noreferrer">
          <ExternalLink /> {program.sourceName}
        </a>
      </details>
      <p className="breathing-comfort">
        Дышите без усилия. При головокружении или нехватке воздуха остановитесь и вернитесь к обычному
        дыханию.
      </p>
    </section>
  );
}
