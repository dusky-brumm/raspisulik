import { useEffect, useState } from 'react';
import type { Dataset, DateKey, Schedule } from './domain';
import VideoLibrary from './VideoLibrary';
import BreathingPractice from './BreathingPractice';
import { readPreference, writePreference } from './preferences';

const MODE_KEY = `raspisulik:ui:${import.meta.env.BASE_URL}:training-mode`;
export default function TrainingView(props: {
  dataset: Dataset;
  schedule: Schedule;
  date: DateKey;
  today: DateKey;
  setDate: (date: DateKey) => void;
  focusActivity?: string;
  onProgress: (activityId: string, date: DateKey, allDone: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState(() =>
    props.focusActivity ? 'steps' : readPreference(MODE_KEY, ['steps', 'breathing'], 'steps'),
  );
  useEffect(() => {
    writePreference(MODE_KEY, mode);
  }, [mode]);
  return (
    <>
      <div className="training-modes segmented-control" role="group" aria-label="Вид тренировки">
        <button
          className={mode === 'steps' ? 'active' : ''}
          aria-pressed={mode === 'steps'}
          onClick={() => setMode('steps')}
        >
          Упражнения
        </button>
        <button
          className={mode === 'breathing' ? 'active' : ''}
          aria-pressed={mode === 'breathing'}
          onClick={() => setMode('breathing')}
        >
          Дыхание
        </button>
      </div>
      {mode === 'steps' && <VideoLibrary {...props} />}
      <div hidden={mode !== 'breathing'}>
        <BreathingPractice active={mode === 'breathing'} />
      </div>
    </>
  );
}
