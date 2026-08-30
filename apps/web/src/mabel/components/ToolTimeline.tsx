import type { MabelToolEvent } from "../types";

type ToolTimelineProps = {
  events: MabelToolEvent[];
};

export function ToolTimeline({ events }: ToolTimelineProps) {
  return (
    <section className="mabel-panel" aria-label="Tool timeline">
      <div className="mabel-panel-heading">
        <span>Tool timeline</span>
        <small>{events.length} events</small>
      </div>
      {events.length === 0 ? (
        <p className="mabel-muted">Tool calls, results, and approvals will appear here.</p>
      ) : (
        <div className="mabel-timeline">
          {events.map((event) => (
            <article key={event.id} className="mabel-timeline-item">
              <span className="mabel-timeline-kind">{event.type.replace("_", " ")}</span>
              <div className="mabel-timeline-row">
                <strong>{event.tool_name}</strong>
                <span className={`mabel-tool-badge mabel-tool-badge--${event.type}`}>{event.type.replace("_", " ")}</span>
              </div>
              {event.detail ? <pre>{formatDetail(event.detail)}</pre> : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function formatDetail(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return trimmed;
  }
}
