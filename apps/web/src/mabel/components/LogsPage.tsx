import { Info } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { getMabelAdminLogs } from "../api";
import { fetchMabelCached, getMabelCached, MABEL_LOGS_DEFAULT_DAYS, MABEL_LOGS_PAGE_LIMIT, mabelLogsCacheKey } from "../sessionCache";

type LogsSummary = Awaited<ReturnType<typeof getMabelAdminLogs>>;
type UsageView = "tools" | "metrics";

const usageViews: Array<{ id: UsageView; label: string }> = [
  { id: "metrics", label: "Usage" },
  { id: "tools", label: "Tools" },
];

function fmt(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

function money(value?: number): string {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "$0.0000";
}

function toolSource(value?: string | null): string {
  return value || "native";
}

function cell(value: unknown, fallback = "-"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

export function LogsPage() {
  const initialKey = mabelLogsCacheKey();
  const [summary, setSummary] = useState<LogsSummary | null>(() => getMabelCached<LogsSummary>(initialKey));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !getMabelCached<LogsSummary>(initialKey));
  const [days, setDays] = useState(MABEL_LOGS_DEFAULT_DAYS);
  const [usageView, setUsageView] = useState<UsageView>("tools");

  const load = async (nextDays = days, options: { force?: boolean } = {}) => {
    const key = mabelLogsCacheKey(nextDays);
    const cached = getMabelCached<LogsSummary>(key);
    if (!options.force && cached) {
      setSummary(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSummary(await fetchMabelCached(key, () => getMabelAdminLogs({ days: nextDays, limit: MABEL_LOGS_PAGE_LIMIT }), { force: options.force }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (getMabelCached<LogsSummary>(initialKey)) return;
    void load(days);
  }, []);

  const totals = summary?.totals || {};
  const usageRows = summary?.recent?.usage || [];
  const statusRows = summary?.breakdowns?.by_status || [];
  const dailyRows = (summary?.breakdowns?.daily || []).slice(-8).reverse();
  const toolRows = summary?.recent?.tool_calls || [];
  const auditRows = summary?.recent?.audit_events || [];

  return (
    <div className="mabel-page mabel-logs-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Logs</h1>
          <p>Admin-only Mabel conversation usage, spend, run, and tool activity.</p>
        </div>
        <div className="mabel-page__actions mabel-logs-actions">
          <select
            className="mabel-page__search mabel-logs-range"
            value={days}
            aria-label="Logs range"
            onChange={(event) => {
              const next = Number(event.target.value);
              setDays(next);
              void load(next, { force: false });
            }}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>365 days</option>
          </select>
          <button type="button" className="mabel-button mabel-button--ghost" onClick={() => void load(days, { force: true })} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>
      <div className="mabel-page__body">
        {error ? <div className="mabel-form__error">{error}</div> : null}
        <section className="mabel-usage-grid mabel-logs-metrics">
          <Metric label="Requests" value={fmt(totals.requests)} />
          <Metric label="Users" value={fmt(totals.users)} />
          <Metric label="Conversations" value={fmt(totals.conversations)} />
          <Metric label="Tool calls" value={fmt(totals.tool_calls)} />
          <Metric label="Tokens" value={fmt(totals.total_tokens)} />
          <Metric
            label="Est. spend"
            value={money(totals.cost_usd)}
            tooltip={(
              <>
                Estimated from token counts using{" "}
                <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noreferrer">OpenAI API pricing</a>.
                Agents SDK pricing is usage-based across model usage, tool calls, and storage.
              </>
            )}
          />
        </section>

        <section className="mabel-logs-overview-grid">
          <div className="mabel-card mabel-logs-users-card">
            <h2 className="mabel-card__title">Users</h2>
            {(summary?.breakdowns?.by_user || []).length === 0 ? (
              <p className="mabel-muted">No usage logged for this range.</p>
            ) : (
              <ul className="mabel-page__list">
                {(summary?.breakdowns?.by_user || []).slice(0, 12).map((row, index) => (
                  <li key={row.user_email} className="mabel-page__row">
                    <div className="mabel-page__row-main">
                      <strong>{index + 1}. {row.user_email}</strong>
                      <span className="mabel-page__row-id">{fmt(row.requests)} requests</span>
                    </div>
                    <span className="mabel-page__row-meta">{fmt(row.total_tokens)} tokens · {money(row.cost_usd)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mabel-card mabel-logs-usage-card">
            <div className="mabel-logs-card-head">
              <h2 className="mabel-sr-only">Usage</h2>
              <div className="mabel-logs-view-toggle" role="tablist" aria-label="Usage log views">
                {usageViews.map((view) => (
                  <button
                    key={view.id}
                    type="button"
                    role="tab"
                    aria-selected={usageView === view.id}
                    className={`mabel-logs-view-toggle__item${usageView === view.id ? " mabel-logs-view-toggle__item--active" : ""}`}
                    onClick={() => setUsageView(view.id)}
                  >
                    {view.label}
                  </button>
                ))}
              </div>
            </div>

            {usageView === "metrics" ? (
              <div className="mabel-logs-metrics-view">
                <div>
                  <h3 className="mabel-logs-subtitle">Status</h3>
                  <StatList rows={statusRows.map((row) => ({ key: row.status, label: row.status, detail: `${fmt(row.requests)} requests` }))} />
                </div>
                <div>
                  <h3 className="mabel-logs-subtitle">Daily</h3>
                  <StatList rows={dailyRows.map((row) => ({ key: row.date, label: row.date, detail: `${fmt(row.requests)} requests · ${money(row.cost_usd)}` }))} columns />
                </div>
              </div>
            ) : null}
            {usageView === "tools" ? (
              <div className="mabel-logs-tools-view">
                <ul className="mabel-page__tools">
                  {toolRows.length === 0 && auditRows.length === 0 ? <li className="mabel-muted">No tool activity logged.</li> : null}
                  {toolRows.slice(0, 10).map((row) => (
                    <li key={`${row.run_id}-${row.id ?? row.created_at}`} className="mabel-page__tool">
                      <div className="mabel-page__tool-main">
                        <strong>{row.tool_name}</strong>
                        <span>{toolSource(row.server_slug)} · {row.created_at || ""}</span>
                      </div>
                      <span className="mabel-pill">{row.status}</span>
                    </li>
                  ))}
                  {auditRows.slice(0, 6).map((row) => (
                    <li key={`${row.id ?? row.actor_email}-${row.created_at}`} className="mabel-page__tool">
                      <div className="mabel-page__tool-main">
                        <strong>{row.event_type}</strong>
                        <span>audit · {row.actor_email} · {row.created_at || ""}</span>
                      </div>
                      <span className="mabel-pill">{row.status}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>

        <section className="mabel-card mabel-logs-recent-card">
          <h2 className="mabel-card__title">Recent logs</h2>
          {usageRows.length === 0 ? (
            <p className="mabel-muted">No request logs found.</p>
          ) : (
            <div className="mabel-logs-table-wrap">
              <table className="mabel-logs-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Surface</th>
                    <th>Status</th>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Est. spend</th>
                  </tr>
                </thead>
                <tbody>
                  {usageRows.slice(0, 80).map((row) => {
                    const usage = row.usage && typeof row.usage === "object" ? row.usage as Record<string, unknown> : {};
                    return (
                      <tr key={`${cell(row.run_id)}-${cell(row.created_at)}`}>
                        <td>{cell(row.created_at)}</td>
                        <td>{cell(row.user_email)}</td>
                        <td>{cell(row.surface)}</td>
                        <td>{cell(row.status)}</td>
                        <td>{cell(row.model)}</td>
                        <td>{fmt(Number(usage.total_tokens || 0))}</td>
                        <td>{money(Number(usage.cost_usd || 0))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatList({ rows, columns = false }: { rows: Array<{ key: string; label: string; detail: string }>; columns?: boolean }) {
  if (rows.length === 0) return <p className="mabel-muted">No usage logged.</p>;

  return (
    <ul className={`mabel-page__tools mabel-logs-stat-list${columns ? " mabel-logs-stat-list--daily" : ""}`}>
      {rows.map((row) => (
        <li key={row.key} className="mabel-page__tool mabel-logs-stat-row">
          <div className="mabel-page__tool-main">
            <strong>{row.label}</strong>
            <span>{row.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Metric({ label, value, tooltip }: { label: string; value: string; tooltip?: ReactNode }) {
  return (
    <div className={`mabel-card mabel-usage-metric${tooltip ? " mabel-usage-metric--with-tooltip" : ""}`}>
      <span className="mabel-usage-metric__label">
        {label}
        {tooltip ? (
          <span className="mabel-usage-metric__hint" role="button" tabIndex={0} aria-label={`${label} info`}>
            <Info size={12} strokeWidth={2} aria-hidden="true" />
            <span className="mabel-usage-metric__tooltip" role="tooltip">{tooltip}</span>
          </span>
        ) : null}
      </span>
      <strong>{value}</strong>
    </div>
  );
}
