import type { MabelBootstrap } from "../types";

type StarterPacksPanelProps = {
  starterPacks: MabelBootstrap["starter_packs"];
};

export function StarterPacksPanel({ starterPacks }: StarterPacksPanelProps) {
  return (
    <section className="mabel-panel">
      <div className="mabel-panel-heading">
        <span>Starter packs</span>
        <small>{starterPacks.length}</small>
      </div>
      {starterPacks.length === 0 ? (
        <p className="mabel-muted">No workflows yet.</p>
      ) : (
        starterPacks.map((pack) => (
          <article key={pack.id} className="mabel-list-item">
            <strong>{pack.name}</strong>
            <span>{pack.role_key || pack.status || "draft"}</span>
          </article>
        ))
      )}
    </section>
  );
}
