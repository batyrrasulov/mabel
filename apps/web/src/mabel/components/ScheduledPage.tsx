import { useEffect, useMemo, useState } from "react";

import { getMabelScheduled, runMabelScheduledTask, updateMabelScheduledTask } from "../api";
import { fetchMabelCached, getMabelCached, invalidateMabelCache, mabelCacheKey } from "../sessionCache";
import type { MabelScheduledRun, MabelScheduledTask } from "../types";

type ScheduledPageProps = {
  onCountChange?: (count: number) => void;
  onOpenConversation?: (conversationId: number) => void;
  onCreateInChat: (prompt: string, intent?: undefined, hiddenInstructions?: string) => void;
};

const SCHEDULE_LABELS: Record<string, string> = {
  hourly: "Hourly",
  morning: "Morning",
  daily: "Daily",
  afternoon: "Afternoon",
  evening: "Evening",
  weekly: "Weekly",
};

function formatDate(value?: string | null, timezone?: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  if (timezone) options.timeZone = timezone;
  try {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  } catch {
    const { timeZone: _ignored, ...fallbackOptions } = options;
    return new Intl.DateTimeFormat(undefined, fallbackOptions).format(date);
  }
}

function taskStatusClass(status: string): string {
  if (status === "active") return "mabel-pill mabel-pill--ok";
  if (status === "paused") return "mabel-pill";
  return "mabel-pill mabel-pill--warn";
}

const CREATE_SCHEDULED_TASK_PROMPT = "Help me schedule a Mabel task.";
const CREATE_SCHEDULED_TASK_HIDDEN_INSTRUCTIONS =
  "Explain scheduled Mabel tasks in one concise paragraph. Interview the user for the exact prompt to rerun, the cadence, timezone, and the exact clock time such as 7 AM or 9 PM. If the user gives an exact time, convert it to a 5-field cron expression and call mabel_create_scheduled_task with schedule_kind='cron', cron, timezone, name, and prompt. Do not settle for only morning/daily if the user gave a specific time.";

export function ScheduledPage({ onCountChange, onOpenConversation, onCreateInChat }: ScheduledPageProps) {
  const cachedScheduled = getMabelCached<{ tasks: MabelScheduledTask[]; runs: MabelScheduledRun[] }>(mabelCacheKey("scheduled"));
  const [tasks, setTasks] = useState<MabelScheduledTask[]>(cachedScheduled?.tasks || []);
  const [runs, setRuns] = useState<MabelScheduledRun[]>(cachedScheduled?.runs || []);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(!cachedScheduled);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = async (options: { force?: boolean } = {}) => {
    const cacheKey = mabelCacheKey("scheduled");
    if (!options.force && getMabelCached(cacheKey)) {
      setLoading(false);
    }
    setError("");
    try {
      const payload = await fetchMabelCached(cacheKey, () => getMabelScheduled(), { force: options.force });
      setTasks(payload.tasks);
      setRuns(payload.runs);
      onCountChange?.(payload.tasks.filter((task) => task.status === "active").length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filteredTasks = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (task) =>
        task.name.toLowerCase().includes(q) ||
        task.prompt.toLowerCase().includes(q) ||
        (task.workflow_id || "").toLowerCase().includes(q),
    );
  }, [search, tasks]);

  const runsByTask = useMemo(() => {
    const map = new Map<string, MabelScheduledRun[]>();
    for (const run of runs) {
      map.set(run.task_id, [...(map.get(run.task_id) || []), run]);
    }
    return map;
  }, [runs]);

  const patchTask = async (task: MabelScheduledTask, patch: Partial<MabelScheduledTask>) => {
    setBusyId(task.id);
    setError("");
    try {
      const updated = await updateMabelScheduledTask(task.id, patch);
      setTasks((prev) => prev.map((row) => (row.id === task.id ? updated : row)));
      invalidateMabelCache(mabelCacheKey("scheduled"));
      onCountChange?.(tasks.map((row) => (row.id === task.id ? updated : row)).filter((row) => row.status === "active").length);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const runTask = async (task: MabelScheduledTask) => {
    setBusyId(task.id);
    setError("");
    try {
      const payload = await runMabelScheduledTask(task.id);
      invalidateMabelCache(mabelCacheKey("scheduled"));
      setTasks((prev) => prev.map((row) => (row.id === task.id ? payload.task : row)));
      setRuns((prev) => [payload.run, ...prev.filter((run) => run.id !== payload.run.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mabel-page mabel-scheduled-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Scheduled</h1>
          <p>Recurring Mabel tasks for heartbeats and monitoring follow-ups.</p>
        </div>
        <div className="mabel-page__actions">
          <input
            className="mabel-page__search"
            placeholder="Search scheduled tasks"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="mabel-button"
            onClick={() => onCreateInChat(CREATE_SCHEDULED_TASK_PROMPT, undefined, CREATE_SCHEDULED_TASK_HIDDEN_INSTRUCTIONS)}
          >
            Create task
          </button>
        </div>
      </header>

      <div className="mabel-page__body">
        <section className="mabel-card">
          <h2 className="mabel-card__title">Tasks</h2>
          {error ? <div className="mabel-form__error">{error}</div> : null}
          {loading ? <p className="mabel-muted">Loading scheduled tasks...</p> : null}
          {!loading && filteredTasks.length === 0 ? (
            <p className="mabel-muted">No scheduled tasks yet. Create one from chat and Mabel will save it here.</p>
          ) : null}
          {filteredTasks.length > 0 ? (
            <ul className="mabel-page__list">
              {filteredTasks.map((task) => {
                const taskRuns = runsByTask.get(task.id) || [];
                return (
                  <li key={task.id} className="mabel-page__row mabel-page__row--column mabel-scheduled-task">
                    <div className="mabel-page__row-top">
                      <div className="mabel-page__row-main">
                        <strong>{task.name}</strong>
                      </div>
                      <div className="mabel-page__row-side">
                        <span className={taskStatusClass(task.status)}>{task.status}</span>
                        <span className="mabel-page__row-meta">{SCHEDULE_LABELS[task.schedule_kind] || task.schedule_kind}</span>
                      </div>
                      <div className="mabel-page__row-actions">
                        <button type="button" className="mabel-button" disabled={busyId === task.id} onClick={() => runTask(task)}>
                          {busyId === task.id ? "Running..." : "Run now"}
                        </button>
                        <button
                          type="button"
                          className="mabel-button mabel-button--ghost"
                          disabled={busyId === task.id}
                          onClick={() => patchTask(task, { status: task.status === "active" ? "paused" : "active" })}
                        >
                          {task.status === "active" ? "Pause" : "Resume"}
                          </button>
                      </div>
                    </div>
                    <div className="mabel-page__sub mabel-page__sub--inline">
                      <span className="mabel-scheduled-next">Next: {formatDate(task.next_run_at, task.timezone)} · Last: {formatDate(task.last_run_at, task.timezone)}</span>
                    </div>
                    {taskRuns[0] ? (
                      <div className="mabel-workflow-run">
                        <div className="mabel-workflow-run__head">
                          <div>
                            <strong>Latest run</strong>
                            <span>{taskRuns[0].id}</span>
                          </div>
                          <div className="mabel-page__row-actions">
                            {taskRuns[0].conversation_id ? (
                              <button
                                type="button"
                                className="mabel-button mabel-button--ghost"
                                onClick={() => onOpenConversation?.(taskRuns[0].conversation_id as number)}
                              >
                                Open chat
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <div className="mabel-workflow-run__logs">
                          <strong>{formatDate(taskRuns[0].created_at, task.timezone)}</strong>
                          <span>{taskRuns[0].summary}</span>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}
