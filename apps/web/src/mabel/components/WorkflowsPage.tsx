import { useMemo, useState } from "react";

import type { UsageMap } from "../hooks/useUsageTracker";
import { RecentSessions } from "./RecentSessions";
import type { MabelBootstrap, MabelConversationSummary } from "../types";

type WorkflowsPageProps = {
  bootstrap: MabelBootstrap;
  onRunPack: (pack: MabelBootstrap["starter_packs"][number]) => Promise<void> | void;
  onBuildWorkflow: () => void;
  onRefresh: () => Promise<void> | void;
  usage: UsageMap;
  conversations: MabelConversationSummary[];
  onOpenConversation: (conversationId: number) => void;
};

function skillLabelForPack(
  pack: MabelBootstrap["starter_packs"][number],
  skillId: string,
  skillNameById: Map<string, string>,
): string {
  const displayNames = pack.policies?.skill_display_names;
  if (displayNames && typeof displayNames === "object" && skillId in displayNames) {
    return String((displayNames as Record<string, string>)[skillId]);
  }
  return skillNameById.get(skillId) || skillId;
}

function connectorSlugsForPack(pack: MabelBootstrap["starter_packs"][number]): string[] {
  const skillIds = new Set((pack.skill_ids || []).map((skillId) => skillId));
  return (pack.connector_slugs || []).filter((slug) => slug !== "product-usage" && !skillIds.has(slug));
}

export function WorkflowsPage({
  bootstrap,
  onRunPack,
  onBuildWorkflow,
  onRefresh,
  usage,
  conversations,
  onOpenConversation,
}: WorkflowsPageProps) {
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bootstrap.starter_packs;
    return bootstrap.starter_packs.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.role_key || "").toLowerCase().includes(q),
    );
  }, [bootstrap.starter_packs, search]);

  const skillNameById = useMemo(
    () => new Map(bootstrap.skills.map((skill) => [skill.id, skill.name])),
    [bootstrap.skills],
  );
  const connectorNameById = useMemo(
    () => new Map(bootstrap.connectors.map((connector) => [connector.id, connector.name])),
    [bootstrap.connectors],
  );

  return (
    <div className="mabel-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Workflows</h1>
          <p>Starter packs loaded into chat with skills, MCP bindings, and agent-loop runs.</p>
        </div>
        <div className="mabel-page__actions">
          <input
            className="mabel-page__search"
            placeholder="Search workflows"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="button" className="mabel-button" onClick={onBuildWorkflow}>
            Build workflow
          </button>
        </div>
      </header>

      <div className="mabel-page__body">
        <section className="mabel-card">
          {filtered.length === 0 ? (
            <p className="mabel-muted">
              {bootstrap.starter_packs.length === 0
                ? "No workflows yet."
                : "No workflows match this search."}
            </p>
          ) : (
            <ul className="mabel-page__list">
              {filtered.map((pack) => {
                const connectorSlugs = connectorSlugsForPack(pack);
                return (
                  <li key={pack.id} className="mabel-page__row mabel-page__row--column">
                    <div className="mabel-page__row-top">
                      <div className="mabel-page__row-main">
                        <strong>{pack.name}</strong>
                        <span className="mabel-page__row-id">{pack.id}</span>
                      </div>
                      <div className="mabel-page__row-side">
                        <span className="mabel-pill">{pack.status || "draft"}</span>
                        <span className="mabel-page__row-meta">{pack.role_key || "—"}</span>
                      </div>
                      <div className="mabel-page__row-actions">
                        <button
                          type="button"
                          className="mabel-button"
                          disabled={busyId === pack.id}
                          onClick={async () => {
                            setBusyId(pack.id);
                            setErrorById((prev) => ({ ...prev, [pack.id]: "" }));
                            try {
                              await onRunPack(pack);
                              await onRefresh();
                            } catch (err) {
                              setErrorById((prev) => ({
                                ...prev,
                                [pack.id]: err instanceof Error ? err.message : String(err),
                              }));
                            } finally {
                              setBusyId(null);
                            }
                          }}
                        >
                          {busyId === pack.id ? "Running..." : "Run"}
                        </button>
                      </div>
                    </div>
                    <div className="mabel-page__sub mabel-page__sub--inline">
                      {(pack.skill_ids || []).length > 0 ? (
                        <div className="mabel-page__chips" aria-label={`${pack.name} skills`}>
                          {(pack.skill_ids || []).map((skillId) => (
                            <span key={skillId} className="mabel-pill mabel-pill--ok">
                              Skill: {skillLabelForPack(pack, skillId, skillNameById)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {connectorSlugs.length > 0 ? (
                        <div className="mabel-page__chips" aria-label={`${pack.name} MCP bindings`}>
                          {connectorSlugs.map((slug) => (
                            <span key={slug} className="mabel-pill mabel-pill--ok">
                              MCP: {connectorNameById.get(slug) || slug}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <RecentSessions
                      label="Recent runs"
                      conversationIds={usage[pack.id] || []}
                      conversations={conversations}
                      onOpen={onOpenConversation}
                    />
                    {errorById[pack.id] ? <div className="mabel-form__error">{errorById[pack.id]}</div> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
