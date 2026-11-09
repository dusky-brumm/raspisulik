import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Upload } from 'lucide-react';
import { dataClient } from './data-client';
import { todayInZone } from './domain';
import { downloadFile } from './file-download';
import type { WorkoutSnapshot } from './video-store';
import type { ArchiveProgress } from './workout-archive';
import { videoStore, withWorkoutLock } from './workout-store';

function message(error: unknown): string {
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return 'В браузере недостаточно места. Существующие данные сохранены.';
  return error instanceof Error ? error.message : 'Не удалось создать или открыть копию.';
}
const phaseLabels: Record<ArchiveProgress['phase'], string> = {
  preparing: 'Подготовка видео',
  exporting: 'Создание архива',
  reading: 'Чтение архива',
  checking: 'Проверка файлов',
};

export default function BackupPanel({
  onImported,
  onBusyChange,
}: {
  onImported: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<ArchiveProgress>();
  const [pending, setPending] = useState<WorkoutSnapshot>();
  const scheduleFile = useRef<HTMLInputElement>(null),
    archiveFile = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const running = useRef(false);
  useEffect(
    () => () => {
      controller.current?.abort();
      onBusyChange(false);
    },
    [onBusyChange],
  );

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(label);
    onBusyChange(true);
    setError('');
    setNotice('');
    setProgress(undefined);
    const abort = new AbortController();
    controller.current = abort;
    try {
      await work(abort.signal);
    } catch (error) {
      if (!abort.signal.aborted) setError(message(error));
    } finally {
      running.current = false;
      controller.current = undefined;
      setBusy('');
      setProgress(undefined);
      onBusyChange(false);
    }
  }
  function exportSchedule() {
    void run('Экспорт расписания', async () => {
      const text = await dataClient.exportPersonal();
      downloadFile(new Blob([text], { type: 'application/json' }), `raspisulik-${todayInZone()}.json`);
      setNotice('Копия расписания скачана');
    });
  }
  function importSchedule(file: File) {
    void run('Импорт расписания', async () => {
      if (file.size > 2_000_000) throw new Error('Выберите JSON-файл размером до 2 МБ.');
      await dataClient.importPersonal(await file.text());
      await onImported();
    });
  }
  function exportWorkouts() {
    void run('Экспорт тренировок', async (signal) => {
      const snapshot = await withWorkoutLock(() => videoStore.snapshot('personal'));
      const { exportWorkoutArchive } = await import('./workout-archive');
      const blob = await exportWorkoutArchive(snapshot, { signal, progress: setProgress });
      signal.throwIfAborted();
      downloadFile(blob, `raspisulik-workouts-${todayInZone()}.zip`);
      setNotice('Архив тренировок скачан');
    });
  }
  function readWorkouts(file: File) {
    setPending(undefined);
    void run('Открытие архива', async (signal) => {
      const { readWorkoutArchive } = await import('./workout-archive');
      setPending(await readWorkoutArchive(file, { signal, progress: setProgress }));
    });
  }
  function restoreWorkouts() {
    if (!pending) return;
    void run('Восстановление тренировок', async () => {
      const result = await withWorkoutLock(() => videoStore.restore('personal', pending));
      window.dispatchEvent(new Event('raspisulik:workouts-changed'));
      setPending(undefined);
      setNotice(
        result.collections || result.clips || result.marks || result.media
          ? `Добавлено подборок: ${result.collections}, шагов: ${result.clips}, отметок: ${result.marks}${result.unlinked ? `. Без связи с задачей: ${result.unlinked}` : ''}`
          : 'Все данные из архива уже есть в этом браузере',
      );
    });
  }
  const percent = progress
    ? Math.min(100, Math.round((progress.completed / Math.max(1, progress.total)) * 100))
    : 0;

  return (
    <div className="backup-panel">
      <p className="help-intro">Мои планы · копии для переноса и восстановления</p>
      <section className="backup-section">
        <h3>Расписание и отметки</h3>
        <p>JSON · группы, задачи и выполнение</p>
        <div className="backup-actions">
          <button
            className="secondary-button"
            aria-label="Скачать расписание JSON"
            disabled={Boolean(busy)}
            onClick={exportSchedule}
          >
            <Download /> Скачать
          </button>
          {dataClient.browser && (
            <button
              className="secondary-button"
              aria-label="Открыть расписание JSON"
              disabled={Boolean(busy)}
              onClick={() => scheduleFile.current?.click()}
            >
              <Upload /> Открыть
            </button>
          )}
        </div>
        {dataClient.browser && (
          <p className="hint-text">
            Импорт расписания сохраняет отметки. Импорт копии восстанавливает отметки из файла.
          </p>
        )}
      </section>
      <section className="backup-section">
        <h3>Тренировки</h3>
        <p>ZIP · видео, инструкции и все отметки шагов</p>
        <div className="backup-actions">
          <button
            className="secondary-button"
            aria-label="Скачать тренировки ZIP"
            disabled={Boolean(busy)}
            onClick={exportWorkouts}
          >
            <Download /> Скачать
          </button>
          <button
            className="secondary-button"
            aria-label="Открыть тренировки ZIP"
            disabled={Boolean(busy)}
            onClick={() => archiveFile.current?.click()}
          >
            <Upload /> Открыть
          </button>
        </div>
        {pending && (
          <div className="archive-preview">
            <p>
              В архиве: {pending.library.collections.length} подборок, {pending.library.clips.length} шагов,{' '}
              {pending.media.size} видеофайлов
            </p>
            <p className="hint-text">
              Добавятся недостающие данные. Текущие названия, порядок шагов и файлы сохранятся.
            </p>
            <div className="backup-actions">
              <button className="text-button" disabled={Boolean(busy)} onClick={() => setPending(undefined)}>
                Отмена
              </button>
              <button className="primary-button" disabled={Boolean(busy)} onClick={restoreWorkouts}>
                Добавить из архива
              </button>
            </div>
          </div>
        )}
      </section>
      {busy && (
        <div className="backup-progress" role="status">
          <LoaderCircle className="spin" />
          <span>{progress ? `${phaseLabels[progress.phase]} · ${percent}%` : busy}</span>
          {['Экспорт тренировок', 'Открытие архива'].includes(busy) && (
            <button
              className="text-button"
              onClick={() => {
                controller.current?.abort();
                setNotice('Отменено');
              }}
            >
              Отмена
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="backup-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="video-notice" role="status">
          {notice}
        </p>
      )}
      <input
        ref={scheduleFile}
        type="file"
        accept=".json,application/json"
        className="file-input"
        aria-label="Файл расписания"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) importSchedule(file);
        }}
      />
      <input
        ref={archiveFile}
        type="file"
        accept=".zip,application/zip"
        className="file-input"
        aria-label="Архив тренировок"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) readWorkouts(file);
        }}
      />
    </div>
  );
}
