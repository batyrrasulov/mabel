import { useEffect, useState } from "react";

import { getMabelUsageSummary } from "../api";
import { fetchMabelCached, getMabelCached, mabelCacheKey } from "../sessionCache";

type UsageSummary = Awaited<ReturnType<typeof getMabelUsageSummary>>;

const DEFAULT_DAYS = 7;

function fmt(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

type UsagePageProps = {
  onSummary?: (summary: UsageSummary) => void;
};

export function UsagePage({ onSummary }: UsagePageProps) {
  const cacheKey = mabelCacheKey("usage", DEFAULT_DAYS);
  const [summary, setSummary] = useState<UsageSummary | null>(() => getMabelCached<UsageSummary>(cacheKey));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !getMabelCached<UsageSummary>(cacheKey));
  const [days, setDays] = useState(DEFAULT_DAYS);

  const load = async (nextDays = days, options: { force?: boolean } = {}) => {
    const key = mabelCacheKey("usage", nextDays);
    if (!options.force && getMabelCached<UsageSummary>(key)) {
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const next = await fetchMabelCached(key, () => getMabelUsageSummary({ days: nextDays }), { force: options.force });
      setSummary(next);
      onSummary?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(days);
  }, []);

  const totals = summary?.totals || {};
  return (
    <div className="mabel-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Usage</h1>
          <p>Request and token telemetry captured by Mabel runs.</p>
        </div>
        <div className="mabel-page__actions mabel-logs-actions">
          <select
            className="mabel-page__search mabel-logs-range"
            value={days}
            aria-label="Usage range"
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
        <section className="mabel-usage-grid">
          <Metric label="Requests" value={fmt(totals.requests)} />
          <Metric label="Input tokens" value={fmt(totals.input_tokens)} />
          <Metric label="Output tokens" value={fmt(totals.output_tokens)} />
          <Metric label="Total tokens" value={fmt(totals.total_tokens)} />
        </section>
        <section className="mabel-card">
          <h2 className="mabel-card__title">Leaderboard</h2>
          {(summary?.leaderboard || []).length === 0 ? (
            <p className="mabel-muted">No usage logged yet.</p>
          ) : (
            <ul className="mabel-page__list">
              {(summary?.leaderboard || []).map((row, index) => (
                <li key={row.user_email} className="mabel-page__row">
                  <div className="mabel-page__row-main">
                    <strong>{index + 1}. {row.user_email}</strong>
                    <span className="mabel-page__row-id">{fmt(row.requests)} requests</span>
                  </div>
                  <span className="mabel-page__row-meta">{fmt(row.total_tokens)} tokens</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="mabel-card mabel-usage-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
