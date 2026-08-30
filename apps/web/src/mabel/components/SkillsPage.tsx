import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createMabelSkill,
  getMabelSkills,
  deleteMabelSkill,
  getMabelSkill,
  getMabelSkillMarketplace,
  shareMabelSkill,
  syncMabelSkillMarketplace,
  updateMabelSkill,
  type MabelSkillMarketplace,
} from "../api";
import type { UsageMap } from "../hooks/useUsageTracker";
import { fetchMabelCached, getMabelCached, invalidateMabelCache, mabelCacheKey, mabelSkillDetailCacheKey, mabelSkillMetaCacheKey, setMabelCached } from "../sessionCache";
import { ConfirmDialog } from "./ConfirmDialog";
import { Markdown } from "./Markdown";
import { RecentSessions } from "./RecentSessions";
import { mabelUiConnectorDisplayName, mabelUiConnectorIsAvailable, mabelUiVisibleConnectors } from "../connectorUi";
import type { MabelBootstrap, MabelConversationSummary } from "../types";

type SkillsPageProps = {
  bootstrap: MabelBootstrap;
  onRefresh: () => Promise<void> | void;
  onUseInChat: (prompt: string, intent?: { kind: "skill"; id: string }, hiddenInstructions?: string) => void;
  usage: UsageMap;
  conversations: MabelConversationSummary[];
  onOpenConversation: (conversationId: number) => void;
  initialSearch?: string;
  onCountChange?: (count: number) => void;
};

type Mode = "list" | "create" | "edit";

type SkillForm = {
  id: string;
  name: string;
  description: string;
  owner_team: string;
  content_md: string;
  tags: string;
  selectedConnectors: string[];
};

const emptyForm = (): SkillForm => ({
  id: "",
  name: "",
  description: "",
  owner_team: "mabel",
  content_md: "",
  tags: "",
  selectedConnectors: [],
});

const CREATE_WITH_MABEL_PROMPT = "Help me create a new Mabel skill.";
const CREATE_WITH_MABEL_HIDDEN_INSTRUCTIONS =
  "Help me create a new Mabel skill. Ask what it should do and which MCP connectors it needs, confirm the connector list, draft the instructions, then use mabel_create_skill with non-empty mcp_bindings_json when connectors are required.";

function skillChatVisiblePrompt(skillName: string): string {
  return `Use ${skillName} skill.`;
}

function skillChatHiddenInstructions(skillId: string): string {
  return `First call mabel_get_skill with skill_id="${skillId}", then follow that skill's instructions. Ask for any required inputs before calling MCP tools. Generate and save requested artifacts directly with mabel_save_artifact when the skill calls for an artifact.`;
}

let mabelSkillsMarketplaceCache: MabelSkillMarketplace | null = null;
const hydratedSkillMetaIds = new Set<string>();

function fetchSkillDetailCached(skillId: string) {
  return fetchMabelCached(mabelSkillDetailCacheKey(skillId), () => getMabelSkill(skillId));
}

function slugifySkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^skill[._:-]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function skillIdFromName(raw: string): string {
  const slug = slugifySkillName(raw);
  return slug ? `skill.${slug}` : "";
}

function formatSkillContent(form: SkillForm): string {
  const content = form.content_md.trim();
  if (content.startsWith("---")) return content;
  const description = form.description.trim();
  if (!description) return content;
  return [
    "---",
    `name: ${form.name.trim()}`,
    "description: >",
    ...description.split("\n").map((line) => `  ${line}`),
    "---",
    "",
    content,
  ].join("\n");
}

function parseSkillFrontmatter(content: string): Record<string, string> {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const metadata: Record<string, string> = {};
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (value === ">" || value === "|") {
      const block: string[] = [];
      index += 1;
      while (index < lines.length && /^(\s{2,}|\t)/.test(lines[index])) {
        block.push(lines[index].trim());
        index += 1;
      }
      metadata[key] = block.join(" ").trim();
      continue;
    }
    metadata[key] = value.replace(/^["']|["']$/g, "");
    index += 1;
  }
  return metadata;
}

function firstHeading(content: string): string {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("# "));
  return heading ? heading.replace(/^#+\s*/, "").trim() : "";
}

function firstParagraph(content: string): string {
  return (
    content
      .replace(/^---[\s\S]*?---/, "")
      .split(/\n\s*\n/)
      .map((block) => block.replace(/^#+\s*.+$/m, "").trim())
      .find(Boolean) || ""
  );
}

function skillStatusLabel(status?: string): string {
  const normalized = (status || "draft").trim().toLowerCase();
  if (normalized === "review" || normalized === "pending" || normalized === "proposed") {
    return "published";
  }
  return status || "draft";
}

function formatSkillDate(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function displaySkillContent(content?: string): string {
  const text = (content || "").trim();
  return text.replace(/^---[\s\S]*?---\s*/, "").trim() || "No instructions saved yet.";
}

function readSkillFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read uploaded skill file"));
    reader.readAsText(file);
  });
}

function canonicalConnectorSlug(raw: string): string {
  return raw.trim().toLowerCase().replaceAll("_", "-");
}

function bindingSlugs(
  skill: Pick<MabelBootstrap["skills"][number], "mcp_bindings">,
): string[] {
  return Array.from(
    new Set(
      (skill.mcp_bindings || [])
        .map((binding) => binding.server_slug || binding.connector_slug || binding.server || binding.connector)
        .filter((slug): slug is string => Boolean(slug))
        .map((slug) => canonicalConnectorSlug(slug)),
    ),
  );
}

function connectorsToBindings(slugs: string[]): Array<{ server_slug: string }> {
  return slugs.map((slug) => ({ server_slug: canonicalConnectorSlug(slug) }));
}

function parseConnectorDependencies(metadata: Record<string, string>, content: string): string[] {
  const raw = metadata.dependencies || metadata.connectors || "";
  const fromMeta = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^connector\./, ""))
    .map((entry) => canonicalConnectorSlug(entry));
  const fromBody = Array.from(content.matchAll(/connector\.([a-z0-9_-]+)/gi)).map((match) =>
    canonicalConnectorSlug(match[1] || ""),
  );
  return Array.from(new Set([...fromMeta, ...fromBody].filter(Boolean)));
}

function skillMatchesQuery(skill: MabelBootstrap["skills"][number], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tags = (skill.tags || []).join(" ").toLowerCase();
  const bindings = bindingSlugs(skill).join(" ").toLowerCase();
  return (
    skill.id.toLowerCase().includes(q) ||
    skill.name.toLowerCase().includes(q) ||
    (skill.description || "").toLowerCase().includes(q) ||
    tags.includes(q) ||
    bindings.includes(q)
  );
}

export function SkillsPage({ bootstrap, onRefresh, onUseInChat, usage, conversations, onOpenConversation, initialSearch, onCountChange }: SkillsPageProps) {
  const [skills, setSkills] = useState<MabelBootstrap["skills"]>(bootstrap.skills);
  const [mode, setMode] = useState<Mode>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SkillForm>(emptyForm());
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createMenuRef = useRef<HTMLDivElement | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [marketplaceBusy, setMarketplaceBusy] = useState(false);
  const [shareBusyId, setShareBusyId] = useState<string | null>(null);
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null);
  const [previewSkill, setPreviewSkill] = useState<{
    id: string;
    name: string;
    description?: string;
    content_md?: string;
    created_at?: string;
    updated_at?: string;
  } | null>(null);
  const [, setMarketplace] = useState<MabelSkillMarketplace | null>(mabelSkillsMarketplaceCache);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchRows, setSearchRows] = useState<MabelBootstrap["skills"] | null>(null);
  const [dateCache, setDateCache] = useState<Record<string, { created_at?: string; updated_at?: string }>>({});
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const connectedConnectorIds = useMemo(
    () => new Set(bootstrap.connectors.map((connector) => canonicalConnectorSlug(connector.id))),
    [bootstrap.connectors],
  );
  const selectableConnectors = useMemo(
    () =>
      mabelUiVisibleConnectors(bootstrap.connectors)
        .filter((connector) => mabelUiConnectorIsAvailable(connector))
        .sort((a, b) =>
          mabelUiConnectorDisplayName(a.id, a.name).localeCompare(mabelUiConnectorDisplayName(b.id, b.name)),
        ),
    [bootstrap.connectors],
  );

  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return skills;
    if (searchRows) return searchRows;
    return skills.filter((skill) => skillMatchesQuery(skill, q));
  }, [skills, search, searchRows]);

  const loadSkills = useCallback(async (options: { force?: boolean } = {}) => {
    const cacheKey = mabelCacheKey("skills", "all");
    const rows = await fetchMabelCached(cacheKey, () => getMabelSkills(), { force: options.force });
    setSkills(rows);
    onCountChange?.(rows.length);
    return rows;
  }, [onCountChange]);

  useEffect(() => {
    setSkills((prev) => {
      const byId = new Map(prev.map((skill) => [skill.id, skill]));
      for (const row of bootstrap.skills) {
        if (!byId.has(row.id)) {
          byId.set(row.id, row);
        }
      }
      return Array.from(byId.values());
    });
  }, [bootstrap.skills]);

  useEffect(() => {
    const cached = getMabelCached<MabelBootstrap["skills"]>(mabelCacheKey("skills", "all"));
    if (cached) {
      setSkills(cached);
      onCountChange?.(cached.length);
      return;
    }
    void loadSkills().catch(() => undefined);
  }, [loadSkills, onCountChange]);

  useEffect(() => {
    const q = (initialSearch || "").trim();
    if (!q) return;
    setSearch((prev) => (prev === q ? prev : q));
  }, [initialSearch]);

  useEffect(() => {
    if (!createMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && createMenuRef.current?.contains(target)) return;
      setCreateMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [createMenuOpen]);

  useEffect(() => {
    if (mode === "list") {
      setForm(emptyForm());
      setEditingId(null);
      setError(null);
    }
    setCreateMenuOpen(false);
  }, [mode]);

  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchRows(null);
      setSearchBusy(false);
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      setSearchBusy(true);
      getMabelSkills(query)
        .then((rows) => {
          if (!alive) return;
          setSearchRows(rows);
        })
        .catch(() => {
          if (!alive) return;
          setSearchRows([]);
        })
        .finally(() => {
          if (!alive) return;
          setSearchBusy(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  useEffect(() => {
    if (mabelSkillsMarketplaceCache) return;
    let alive = true;
    setMarketplaceBusy(true);
    getMabelSkillMarketplace()
      .then((payload) => {
        mabelSkillsMarketplaceCache = payload;
        if (alive) setMarketplace(payload);
      })
      .catch((err) => {
        const payload = { status: "error", skills: [], error: err instanceof Error ? err.message : String(err) };
        mabelSkillsMarketplaceCache = payload;
        if (alive) setMarketplace(payload);
      })
      .finally(() => {
        if (alive) setMarketplaceBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "list") return;
    const missing = filtered
      .filter((skill) => {
        if (skill.created_at && skill.updated_at) return false;
        if (getMabelCached(mabelSkillMetaCacheKey(skill.id))) return false;
        if (hydratedSkillMetaIds.has(skill.id)) return false;
        return true;
      })
      .slice(0, 8);
    if (missing.length === 0) return;

    const cachedMeta: Record<string, { created_at?: string; updated_at?: string }> = {};
    for (const skill of filtered) {
      const meta = getMabelCached<{ created_at?: string; updated_at?: string }>(mabelSkillMetaCacheKey(skill.id));
      if (meta) cachedMeta[skill.id] = meta;
    }
    if (Object.keys(cachedMeta).length > 0) {
      setDateCache((prev) => ({ ...cachedMeta, ...prev }));
    }

    let alive = true;
    for (const skill of missing) {
      hydratedSkillMetaIds.add(skill.id);
    }
    Promise.all(
      missing.map(async (skill) => {
        try {
          const detail = (await fetchSkillDetailCached(skill.id)).skill || null;
          const meta = detail
            ? { created_at: detail.created_at, updated_at: detail.updated_at }
            : {};
          setMabelCached(mabelSkillMetaCacheKey(skill.id), meta);
          return { id: skill.id, ...meta };
        } catch {
          setMabelCached(mabelSkillMetaCacheKey(skill.id), {});
          return { id: skill.id };
        }
      }),
    ).then((rows) => {
      if (!alive) return;
      setDateCache((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          next[row.id] = { created_at: row.created_at, updated_at: row.updated_at };
        }
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [filtered, mode]);

  const startCreate = () => {
    setMode("create");
    setForm(emptyForm());
    setError(null);
    setUploadOpen(false);
  };

  const startCreateWithMabel = () => {
    setCreateMenuOpen(false);
    onUseInChat(CREATE_WITH_MABEL_PROMPT, undefined, CREATE_WITH_MABEL_HIDDEN_INSTRUCTIONS);
  };

  const startUpload = () => {
    setCreateMenuOpen(false);
    setUploadOpen(true);
    setError(null);
  };

  const startEdit = async (skillId: string) => {
    const existing = skills.find((s) => s.id === skillId) || searchRows?.find((s) => s.id === skillId);
    if (!existing) return;
    setBusy(true);
    setError(null);
    let detail = null;
    try {
      detail = (await fetchSkillDetailCached(skillId)).skill || null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
    setMode("edit");
    setEditingId(skillId);
    setForm({
      id: detail?.id || existing.id,
      name: detail?.name || existing.name,
      description: detail?.description || existing.description || "",
      owner_team: detail?.owner_team || existing.owner_team || "",
      content_md: detail?.content_md || "",
      tags: detail?.tags?.join(", ") || "",
      selectedConnectors: bindingSlugs(detail || existing),
    });
  };

  const importSkillFile = async (file: File) => {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".zip") || lowerName.endsWith(".skill")) {
      throw new Error("Upload a SKILL.md or markdown file here. Zip skill packages can still be unpacked and imported by choosing their SKILL.md file.");
    }
    const text = await readSkillFileText(file);
    const metadata = parseSkillFrontmatter(text);
    const name = metadata.name || firstHeading(text) || file.name.replace(/\.(md|markdown|txt)$/i, "");
    const description = metadata.description || firstParagraph(text);
    setForm({
      id: skillIdFromName(name),
      name,
      description,
      owner_team: metadata.owner_team || metadata.team || "mabel",
      content_md: text.trim(),
      tags: metadata.tags || "",
      selectedConnectors: parseConnectorDependencies(metadata, text),
    });
    setMode("create");
    setUploadOpen(false);
  };

  const handleFilePick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await importSkillFile(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const openSkill = async (skill: MabelBootstrap["skills"][number]) => {
    setPreviewBusyId(skill.id);
    setError(null);
    try {
      const detail = (await fetchSkillDetailCached(skill.id)).skill || null;
      setPreviewSkill({
        id: detail?.id || skill.id,
        name: detail?.name || skill.name,
        description: detail?.description || skill.description,
        content_md: detail?.content_md || "",
        created_at: detail?.created_at || skill.created_at,
        updated_at: detail?.updated_at || skill.updated_at,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewBusyId(null);
    }
  };

  const persist = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        const skillId = form.id || skillIdFromName(form.name);
        if (!skillId || !form.name || !form.owner_team || !form.content_md) {
          throw new Error("Skill name, owner team and instructions are required");
        }
        await createMabelSkill({
          id: skillId,
          name: form.name,
          owner_team: form.owner_team,
          content_md: formatSkillContent(form),
          description: form.description,
          tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
          mcp_bindings: connectorsToBindings(form.selectedConnectors),
        });
      } else if (mode === "edit" && editingId) {
        await updateMabelSkill(editingId, {
          name: form.name || undefined,
          owner_team: form.owner_team || undefined,
          content_md: form.content_md ? formatSkillContent(form) : undefined,
          description: form.description,
          tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          mcp_bindings: connectorsToBindings(form.selectedConnectors),
        });
      }
      invalidateMabelCache(mabelCacheKey("skills"));
      await Promise.all([onRefresh(), loadSkills({ force: true }).catch(() => null)]);
      setMode("list");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const syncMarketplace = async () => {
    setMarketplaceBusy(true);
    setError(null);
    try {
      await syncMabelSkillMarketplace();
      const refreshed = await getMabelSkillMarketplace();
      mabelSkillsMarketplaceCache = refreshed;
      setMarketplace(refreshed);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarketplaceBusy(false);
    }
  };

  const handleShare = async (skillId: string) => {
    setShareBusyId(skillId);
    setError(null);
    setNotice(null);
    try {
      const result = await shareMabelSkill(skillId);
      if (result.skill?.status) {
        setSkills((previous) =>
          previous.map((skill) =>
            skill.id === skillId
              ? { ...skill, status: result.skill!.status! }
              : skill,
          ),
        );
      }
      invalidateMabelCache(mabelCacheKey("skills"));
      await Promise.all([onRefresh(), loadSkills({ force: true })]);
      const compareUrl = result.share?.compare_url;
      setNotice(
        compareUrl
          ? `Skill shared with your org. Teammates can click Sync to pull it in. Compare: ${compareUrl}`
          : "Skill shared with your org. Teammates can click Sync to pull it in.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setShareBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const deletedId = confirmDelete.id;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deleteMabelSkill(deletedId);
      setConfirmDelete(null);
      setSkills((prev) => prev.filter((skill) => skill.id !== deletedId));
      invalidateMabelCache(mabelCacheKey("skills"));
      await Promise.all([onRefresh(), loadSkills({ force: true })]);
      setNotice("Skill deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleConnectorSelection = (connectorId: string) => {
    const slug = canonicalConnectorSlug(connectorId);
    setForm((prev) => {
      const selected = new Set(prev.selectedConnectors);
      if (selected.has(slug)) selected.delete(slug);
      else selected.add(slug);
      return { ...prev, selectedConnectors: Array.from(selected) };
    });
  };


  return (
    <div className="mabel-page">
      <header className="mabel-page__head">
        <div className="mabel-page__title">
          <h1>Skills</h1>
          <p>Instruction packages loaded into chat with MCP-bound tool calls.</p>
        </div>
        <div className="mabel-page__actions">
          {mode === "list" ? (
            <>
              {search.trim() ? (
                <span className="mabel-page__row-meta">{searchBusy ? "Searching..." : `${filtered.length} matches`}</span>
              ) : null}
              <input
                className="mabel-page__search"
                placeholder="Search skills"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" className="mabel-button mabel-button--ghost" onClick={syncMarketplace} disabled={marketplaceBusy}>
                {marketplaceBusy ? "Syncing..." : "Sync"}
              </button>
              <div className="mabel-skill-create" ref={createMenuRef}>
                <button type="button" className="mabel-button" onClick={() => setCreateMenuOpen((open) => !open)} aria-expanded={createMenuOpen}>
                  New skill
                </button>
                {createMenuOpen ? (
                  <div className="mabel-skill-create__menu" role="menu" aria-label="Create skill options">
                    <button type="button" role="menuitem" onClick={startCreateWithMabel}>
                      <strong>Create with Mabel</strong>
                    </button>
                    <button type="button" role="menuitem" onClick={startCreate}>
                      <strong>Write skill instructions</strong>
                    </button>
                    <button type="button" role="menuitem" onClick={startUpload}>
                      <strong>Upload a skill</strong>
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <button type="button" className="mabel-button mabel-button--ghost" onClick={() => setMode("list")}>
              Back
            </button>
          )}
        </div>
      </header>

      <div className="mabel-page__body">
        {mode === "list" && error ? <div className="mabel-page__notice mabel-page__notice--error">{error}</div> : null}
        {mode === "list" && notice ? <div className="mabel-page__notice">{notice}</div> : null}
        {mode !== "list" ? (
          <section className="mabel-card">
            <div className="mabel-form mabel-form--page">
              <label className="mabel-field">
                <span>Skill name</span>
                <input
                  value={form.name}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      name: event.target.value,
                      id: mode === "create" ? skillIdFromName(event.target.value) : prev.id,
                    }))
                  }
                  placeholder="Weekly Status Report"
                />
              </label>
              <label className="mabel-field">
                <span>Description</span>
                <textarea
                  rows={3}
                  value={form.description}
                  onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                  placeholder="Generate weekly status reports from recent work. Use when asked for updates or progress summaries."
                />
              </label>
              <label className="mabel-field">
                <span>Connectors</span>
                <div className="mabel-page__chips" role="group" aria-label="Skill connector bindings">
                  {selectableConnectors.length === 0 ? (
                    <span className="mabel-muted">No enabled connectors available. Turn on connectors on the Connectors page first.</span>
                  ) : (
                    selectableConnectors.map((connector) => {
                      const slug = canonicalConnectorSlug(connector.id);
                      const selected = form.selectedConnectors.includes(slug);
                      return (
                        <button
                          key={connector.id}
                          type="button"
                          className={`mabel-pill${selected ? " mabel-pill--ok" : ""}`}
                          aria-pressed={selected}
                          onClick={() => toggleConnectorSelection(connector.id)}
                        >
                          {mabelUiConnectorDisplayName(connector.id, connector.name)}
                        </button>
                      );
                    })
                  )}
                </div>
              </label>
              <label className="mabel-field">
                <span>Instructions {mode === "edit" ? "(leave empty to keep current)" : ""}</span>
                <textarea
                  rows={10}
                  value={form.content_md}
                  onChange={(event) => setForm((prev) => ({ ...prev, content_md: event.target.value }))}
                  placeholder="Summarize my recent work in three sections: wins, blockers, and next steps. Keep the tone professional but not stiff."
                />
              </label>
              {error ? <div className="mabel-form__error">{error}</div> : null}
              <div className="mabel-form__actions">
                <button type="button" className="mabel-button" onClick={persist} disabled={busy}>
                  {busy ? "Saving…" : mode === "create" ? "Save skill" : "Update skill"}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="mabel-card">
            {filtered.length === 0 ? (
              <p className="mabel-muted">
                {skills.length === 0
                  ? "No skills yet. Create the first one to start a governed workflow."
                  : "No skills match this search."}
              </p>
            ) : (
              <ul className="mabel-page__list">
                {filtered.map((skill) => (
                  <li key={skill.id} className="mabel-page__row mabel-page__row--column">
                    <div className="mabel-page__row-top">
                      <div className="mabel-page__row-main">
                        <strong>{skill.name}</strong>
                        <span className="mabel-page__row-id">{skill.id}</span>
                        {skill.description ? <span className="mabel-page__row-description">{skill.description}</span> : null}
                        {search.trim() && skill.snippet ? (
                          <span className="mabel-page__row-description mabel-page__row-description--snippet">{skill.snippet}</span>
                        ) : null}
                      </div>
                      <div className="mabel-page__row-side mabel-page__row-side--stacked">
                        <div className="mabel-page__row-side-line">
                          <span className="mabel-pill">{skillStatusLabel(skill.status)}</span>
                          <span className="mabel-page__row-meta">{skill.owner_team || "—"}</span>
                        </div>
                        <div className="mabel-page__row-side-line mabel-page__row-side-line--dates">
                          <span className="mabel-page__row-meta">Created {formatSkillDate(skill.created_at || dateCache[skill.id]?.created_at)}</span>
                          <span className="mabel-page__row-meta">Updated {formatSkillDate(skill.updated_at || dateCache[skill.id]?.updated_at)}</span>
                        </div>
                      </div>
                      <div className="mabel-page__row-actions">
                        <button
                          type="button"
                          className="mabel-button"
                          onClick={() =>
                            onUseInChat(
                              skillChatVisiblePrompt(skill.name),
                              { kind: "skill", id: skill.id },
                              skillChatHiddenInstructions(skill.id),
                            )
                          }
                        >
                          Start chat
                        </button>
                        <button
                          type="button"
                          className="mabel-button mabel-button--ghost"
                          onClick={() => void openSkill(skill)}
                          disabled={previewBusyId === skill.id}
                        >
                          {previewBusyId === skill.id ? "Opening..." : "Open"}
                        </button>
                        <button type="button" className="mabel-button mabel-button--ghost" onClick={() => void startEdit(skill.id)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="mabel-button mabel-button--ghost"
                          onClick={() => void handleShare(skill.id)}
                          disabled={shareBusyId === skill.id}
                        >
                          {shareBusyId === skill.id ? "Sharing..." : "Share"}
                        </button>
                        <button
                          type="button"
                          className="mabel-button mabel-button--ghost mabel-button--danger"
                          onClick={() => setConfirmDelete({ id: skill.id, name: skill.name })}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="mabel-page__sub mabel-page__sub--inline">
                      {bindingSlugs(skill).length > 0 ? (
                        <div className="mabel-page__chips" aria-label={`${skill.name} MCP bindings`}>
                          {bindingSlugs(skill).map((slug) => (
                            <span key={slug} className={`mabel-pill ${connectedConnectorIds.has(slug) ? "mabel-pill--ok" : ""}`}>
                              MCP: {slug}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="mabel-page__row-meta">No MCP binding required</span>
                      )}
                      {skill.tags && skill.tags.length > 0 ? (
                        <div className="mabel-page__chips" aria-label={`${skill.name} tags`}>
                          {skill.tags.slice(0, 5).map((tag) => (
                            <span key={tag} className="mabel-page__tag">{tag}</span>
                          ))}
                        </div>
                      ) : null}
                      {search.trim() && skill.matched_fields && skill.matched_fields.length > 0 ? (
                        <div className="mabel-page__chips" aria-label={`${skill.name} matched fields`}>
                          {skill.matched_fields.slice(0, 4).map((field) => (
                            <span key={`${skill.id}-${field}`} className="mabel-page__tag">{field}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <RecentSessions
                      label="Recent runs"
                      conversationIds={usage[skill.id] || []}
                      conversations={conversations}
                      onOpen={onOpenConversation}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      {uploadOpen ? (
        <div className="mabel-modal" role="dialog" aria-modal="true" aria-label="Upload skill">
          <div className="mabel-modal__backdrop" onClick={() => setUploadOpen(false)} aria-hidden="true" />
          <div className="mabel-modal__panel mabel-modal__panel--sm">
            <header className="mabel-modal__head">
              <h2>Upload skill</h2>
              <button type="button" className="mabel-icon-btn" onClick={() => setUploadOpen(false)} aria-label="Close upload skill">
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <section className="mabel-modal__section">
              <button
                type="button"
                className="mabel-skill-upload"
                onClick={() => uploadInputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void handleFilePick(event.dataTransfer.files);
                }}
              >
                <span className="mabel-skill-upload__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" role="presentation">
                    <path d="M3.75 7.25h5.4l1.55 1.7h9.55v8.8a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V7.25Z" />
                    <path d="M12 12.25v4.5M9.75 14.5h4.5" />
                  </svg>
                </span>
                <strong>Drag and drop or click to upload</strong>
                <span>Choose a SKILL.md, .md, or .txt file.</span>
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                className="mabel-skill-upload__input"
                accept=".md,.markdown,.txt"
                onChange={(event) => void handleFilePick(event.currentTarget.files)}
              />
              <p className="mabel-muted">Mabel imports the file into the manual editor so you can review before saving.</p>
              {error ? <div className="mabel-form__error">{error}</div> : null}
            </section>
            <footer className="mabel-modal__foot mabel-modal__foot--split">
              <button type="button" className="mabel-button mabel-button--ghost" onClick={() => setUploadOpen(false)}>
                Cancel
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      {previewSkill ? (
        <div className="mabel-modal" role="dialog" aria-modal="true" aria-label={`${previewSkill.name} skill content`}>
          <div className="mabel-modal__backdrop" onClick={() => setPreviewSkill(null)} aria-hidden="true" />
          <div className="mabel-modal__panel mabel-modal__panel--wide">
            <header className="mabel-modal__head">
              <div>
                <h2>{previewSkill.name}</h2>
                <p className="mabel-modal__subhead">{previewSkill.id}</p>
              </div>
              <button type="button" className="mabel-icon-btn" onClick={() => setPreviewSkill(null)} aria-label="Close skill content">
                <span aria-hidden="true">×</span>
              </button>
            </header>
            <section className="mabel-modal__section">
              {previewSkill.description ? <p className="mabel-skill-preview__description">{previewSkill.description}</p> : null}
              <div className="mabel-skill-preview__meta">
                <span>Created {formatSkillDate(previewSkill.created_at)}</span>
                <span>Updated {formatSkillDate(previewSkill.updated_at)}</span>
              </div>
              <div className="mabel-skill-preview__content">
                <Markdown content={displaySkillContent(previewSkill.content_md)} theme="light" />
              </div>
            </section>
            <footer className="mabel-modal__foot mabel-modal__foot--split">
              <button
                type="button"
                className="mabel-button mabel-button--ghost"
                onClick={() => {
                  setPreviewSkill(null);
                  void startEdit(previewSkill.id);
                }}
              >
                Edit
              </button>
              <button type="button" className="mabel-button" onClick={() => setPreviewSkill(null)}>
                Done
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete skill"
        body={confirmDelete ? `Delete "${confirmDelete.name}"? This cannot be undone.` : ""}
        destructive
        confirmLabel={busy ? "Deleting…" : "Delete"}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}
