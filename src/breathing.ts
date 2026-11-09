export type BreathingProgramId = 'diaphragm' | 'antistress';
export type BreathingPhase = 'inhale' | 'exhale';
export interface BreathingPattern {
  inhaleSeconds: number;
  exhaleSeconds: number;
}
export const BREATHING_PROGRAMS = [
  {
    id: 'diaphragm' as const,
    title: 'Диафрагма',
    description: 'Мягкое дыхание животом',
    inhaleSeconds: 4,
    exhaleSeconds: 4,
    instructions:
      'Сядьте с опорой или лягте удобно. Положите ладонь на живот. На спокойном вдохе живот слегка поднимается, на выдохе — опускается. Расслабьте плечи; не старайтесь набрать больше воздуха.',
    source: 'https://www.cuh.nhs.uk/patient-information/breathing-techniques-to-ease-breathlessness/',
    sourceName: 'Cambridge University Hospitals',
  },
  {
    id: 'antistress' as const,
    title: 'Антистресс',
    description: 'Выдох немного длиннее вдоха',
    inhaleSeconds: 4,
    exhaleSeconds: 6,
    instructions:
      'Устройтесь удобно и расслабьте плечи. Вдыхайте мягко, затем спокойно выдыхайте чуть дольше. Между вдохом и выдохом нет задержки. Если ритм неудобен, сократите время в настройках.',
    source:
      'https://www.cht.nhs.uk/services/clinical-services/oncology/information-and-support/prehabilitation/breathlessness-and-relaxation',
    sourceName: 'Calderdale and Huddersfield NHS',
  },
];

export interface BreathingSession {
  status: 'idle' | 'running' | 'paused' | 'finished';
  totalMs: number;
  elapsedMs: number;
  startedAt: number | null;
}
export type BreathingAction =
  { type: 'start' | 'pause' | 'tick'; now: number } | { type: 'reset'; totalMs: number };

export function createBreathingSession(totalMs: number): BreathingSession {
  if (!Number.isFinite(totalMs) || totalMs < 1000 || totalMs > 60 * 60_000)
    throw new Error('Некорректная длительность практики.');
  return { status: 'idle', totalMs, elapsedMs: 0, startedAt: null };
}
export function breathingElapsed(session: BreathingSession, now: number): number {
  const delta =
    session.status === 'running' && session.startedAt !== null ? Math.max(0, now - session.startedAt) : 0;
  return Math.min(session.totalMs, session.elapsedMs + delta);
}
/** Calculate against a monotonic clock, never against the number of interval callbacks. */
export function breathingReducer(session: BreathingSession, action: BreathingAction): BreathingSession {
  if (action.type === 'reset') return createBreathingSession(action.totalMs);
  if (!Number.isFinite(action.now)) return session;
  const elapsedMs = breathingElapsed(session, action.now);
  if (elapsedMs >= session.totalMs && session.status !== 'idle')
    return { ...session, status: 'finished', elapsedMs: session.totalMs, startedAt: null };
  if (action.type === 'start' && (session.status === 'idle' || session.status === 'paused'))
    return { ...session, status: 'running', startedAt: action.now };
  if (action.type === 'pause' && session.status === 'running')
    return { ...session, status: 'paused', elapsedMs, startedAt: null };
  return session;
}
export function breathingFrame(session: BreathingSession, pattern: BreathingPattern, now: number) {
  if (
    ![pattern.inhaleSeconds, pattern.exhaleSeconds].every(
      (value) => Number.isInteger(value) && value >= 2 && value <= 8,
    )
  )
    throw new Error('Укажите от 2 до 8 секунд на вдох и выдох.');
  const elapsedMs = breathingElapsed(session, now);
  const finished = elapsedMs >= session.totalMs;
  const inhaleMs = pattern.inhaleSeconds * 1000,
    exhaleMs = pattern.exhaleSeconds * 1000;
  const position = elapsedMs % (inhaleMs + exhaleMs);
  const phase: BreathingPhase = position < inhaleMs ? 'inhale' : 'exhale';
  const phaseElapsed = phase === 'inhale' ? position : position - inhaleMs;
  const phaseMs = phase === 'inhale' ? inhaleMs : exhaleMs;
  const progress = phaseElapsed / phaseMs;
  return {
    finished,
    elapsedMs,
    phase,
    phaseSeconds: finished ? 0 : Math.ceil((phaseMs - phaseElapsed) / 1000),
    remainingSeconds: Math.ceil((session.totalMs - elapsedMs) / 1000),
    expansion: finished ? 0 : phase === 'inhale' ? progress : 1 - progress,
    phaseKey: `${Math.floor(elapsedMs / (inhaleMs + exhaleMs))}:${phase}`,
  };
}
export function breathingClock(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)
    .toString()
    .padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`;
}
