import type { MabelBootstrap } from "../types";

type ApprovalsPanelProps = {
  approvals: MabelBootstrap["approvals"];
};

export function ApprovalsPanel({ approvals }: ApprovalsPanelProps) {
  return (
    <section className="mabel-panel">
      <div className="mabel-panel-heading">
        <span>Approvals</span>
        <small>{approvals.length}</small>
      </div>
      {approvals.length === 0 ? (
        <p className="mabel-muted">Controlled actions pause here before write, update, delete, or admin execution.</p>
      ) : (
        approvals.map((approval) => (
          <article key={approval.id} className="mabel-list-item">
            <strong>{approval.title}</strong>
            <span>{approval.requested_by || "pending"}</span>
          </article>
        ))
      )}
    </section>
  );
}
