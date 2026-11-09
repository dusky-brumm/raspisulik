import test from 'node:test';
import assert from 'node:assert/strict';
import {
  breathingClock,
  breathingElapsed,
  breathingFrame,
  breathingReducer,
  createBreathingSession,
} from '../src/breathing.ts';

const pattern = { inhaleSeconds: 4, exhaleSeconds: 6 };
const start = (total = 60_000, now = 1000) =>
  breathingReducer(createBreathingSession(total), { type: 'start', now });

test('breathing phases switch at exact boundaries without hold phases', () => {
  const session = start();
  assert.equal(breathingFrame(session, pattern, 1000).phase, 'inhale');
  assert.equal(breathingFrame(session, pattern, 1000).phaseSeconds, 4);
  assert.equal(breathingFrame(session, pattern, 4999).phase, 'inhale');
  assert.equal(breathingFrame(session, pattern, 5000).phase, 'exhale');
  assert.equal(breathingFrame(session, pattern, 5000).phaseSeconds, 6);
  assert.equal(breathingFrame(session, pattern, 10_999).phase, 'exhale');
  assert.equal(breathingFrame(session, pattern, 11_000).phase, 'inhale');
  assert.equal(breathingFrame(session, pattern, 11_000).phaseKey, '1:inhale');
});

test('a delayed callback catches up to the monotonic clock without accumulating timer drift', () => {
  let session = start();
  for (const now of [1100, 2000, 2100, 33_450]) session = breathingReducer(session, { type: 'tick', now });
  assert.equal(breathingElapsed(session, 33_450), 32_450);
  assert.equal(breathingFrame(session, pattern, 33_450).remainingSeconds, 28);
  assert.equal(breathingFrame(session, pattern, 33_450).phase, 'inhale');
});

test('pause freezes the current phase; resuming counts only active time', () => {
  let session = start();
  session = breathingReducer(session, { type: 'pause', now: 6500 });
  assert.equal(session.status, 'paused');
  const paused = breathingFrame(session, pattern, 6500);
  assert.equal(paused.phase, 'exhale');
  assert.equal(paused.phaseSeconds, 5);
  assert.deepEqual(breathingFrame(session, pattern, 90_000), paused);
  session = breathingReducer(session, { type: 'start', now: 100_000 });
  assert.equal(breathingElapsed(session, 102_500), 8000);
  assert.equal(breathingFrame(session, pattern, 102_500).phaseSeconds, 2);
});

test('finishing is clamped, including pausing at the deadline; reset starts a fresh session', () => {
  for (const type of ['tick', 'pause']) {
    const finished = breathingReducer(start(), { type, now: 1_000_000 });
    assert.equal(finished.status, 'finished');
    assert.equal(finished.elapsedMs, 60_000);
    assert.equal(breathingFrame(finished, pattern, 2_000_000).remainingSeconds, 0);
    assert.equal(breathingFrame(finished, pattern, 2_000_000).phaseSeconds, 0);
    const reset = breathingReducer(finished, { type: 'reset', totalMs: 180_000 });
    assert.deepEqual(reset, createBreathingSession(180_000));
  }
});

test('duplicate starts and pauses cannot move the session clock', () => {
  const running = start();
  assert.equal(breathingReducer(running, { type: 'start', now: 5000 }), running);
  const paused = breathingReducer(running, { type: 'pause', now: 5000 });
  assert.equal(breathingReducer(paused, { type: 'pause', now: 10_000 }), paused);
  assert.equal(breathingReducer(running, { type: 'tick', now: NaN }), running);
  assert.equal(breathingElapsed(running, 500), 0);
});

test('custom rhythms stay bounded and countdown formatting never goes negative', () => {
  for (const value of [0, 1, 1.5, 9, NaN, Infinity])
    assert.throws(() => breathingFrame(start(), { ...pattern, inhaleSeconds: value }, 1000));
  for (const total of [0, -1, Infinity, 60 * 60_000 + 1]) assert.throws(() => createBreathingSession(total));
  assert.equal(breathingClock(59.2), '01:00');
  assert.equal(breathingClock(-1), '00:00');
  assert.equal(breathingClock(600), '10:00');
});
