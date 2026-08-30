import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { setConnectorEnabled, uploadMabelFiles } from "../api";
import { mabelUiConnectorDisplayName, mabelUiConnectorToggleAllowed, mabelUiVisibleConnectors } from "../connectorUi";
import { ProjectsNavIcon } from "../icons/nav-icons";
import type { MabelBootstrap } from "../types";

/** A file picked in the composer. We upload it to /api/v1/uploads
 *  immediately on pick and track its upload state on the chip so the user
 *  sees `uploading…` → `ready` (or `failed`) in real time. By the time they
 *  hit Send, the file already has a server-side id; the chat turn just
 *  references that id, no second upload race. */
type AttachedFileBase = {
  /** Local stable id for React keys + remove. Replaced with the server id
   *  once upload completes (chip key stays stable via React's key memo). */
  id: string;
  name: string;
  size: number;
  type: string;
};

export type AttachedFile =
  | (AttachedFileBase & {
      kind: "local";
      file: File;
      uploadedId?: string;
      status: "uploading" | "ready" | "error";
      error?: string;
    })
  | (AttachedFileBase & {
      kind: "library";
      uploadedId: string;
      status: "ready";
    });

export type SlashAction =
  | { type: "prompt"; text: string }
  | { type: "help" }
  | { type: "settings" }
  | { type: "start-my-day" };

type PromptComposerProps = {
  disabled?: boolean;
  isStreaming?: boolean;
  bootstrap: MabelBootstrap;
  /** Full skill registry for @ mentions (bootstrap may only include launch-ready skills). */
  mentionSkills?: MabelBootstrap["skills"];
  /** Optional slash commands prepended before the core list (e.g. /start-my-day). */
  slashCommands?: CommandHit[];
  onSubmit: (message: string, attachments: AttachedFile[]) => void;
  onStop?: () => void;
  onSlashAction?: (action: SlashAction) => void;
  initialValue?: string | null;
  onInitialConsumed?: () => void;
  onConnectorsChanged?: () => Promise<void> | void;
  initialAttachments?: AttachedFile[] | null;
  onInitialAttachmentsConsumed?: () => void;
  contextLabel?: string;
  /** When this value changes, the MCP control returns to icon-only and closes the menu. */
  connectorsControlResetKey?: number;
  autoRevealConnectors?: boolean;
};

type CommandHit = {
  key: string;
  label: string;
  insert?: string;
  hint?: string;
  action?: SlashAction;
};

const CORE_SLASH_COMMANDS: CommandHit[] = [
  {
    key: "/mcp",
    label: "/mcp",
    hint: "List MCP connectors",
    action: { type: "prompt", text: "List the MCP connectors available, their tool counts, and which are enabled." },
  },
  {
    key: "/skills",
    label: "/skills",
    hint: "List my Mabel skills",
    action: { type: "prompt", text: "List my Mabel skills with their owners, status, and what each is for." },
  },
  {
    key: "/workflows",
    label: "/workflows",
    hint: "List my workflows",
    action: {
      type: "prompt",
      text: "List my Mabel workflows and starter packs with their skills, MCP connectors, and what each workflow is for.",
    },
  },
  { key: "/help", label: "/help", hint: "What can Mabel do?", action: { type: "help" } },
];

export function PromptComposer({
  disabled = false,
  isStreaming = false,
  bootstrap,
  mentionSkills,
  slashCommands = [],
  onSubmit,
  onStop,
  onSlashAction,
  initialValue,
  onInitialConsumed,
  onConnectorsChanged,
  initialAttachments,
  onInitialAttachmentsConsumed,
  contextLabel,
  connectorsControlResetKey = 0,
  autoRevealConnectors = false,
}: PromptComposerProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const [menu, setMenu] = useState<"slash" | "mention" | null>(null);
  const [menuQuery, setMenuQuery] = useState("");
  const [connectorsControlRevealed, setConnectorsControlRevealed] = useState(false);
  const [connectorMenuOpen, setConnectorMenuOpen] = useState(false);
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null);
  const [connectorError, setConnectorError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const connectorRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (initialValue && initialValue.length > 0) {
      setValue(initialValue);
      onInitialConsumed?.();
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [initialValue]);

  useEffect(() => {
    if (!initialAttachments || initialAttachments.length === 0) return;
    setAttachments(initialAttachments);
    onInitialAttachmentsConsumed?.();
  }, [initialAttachments, onInitialAttachmentsConsumed]);

  useEffect(() => {
    setConnectorsControlRevealed(false);
    setConnectorMenuOpen(false);
  }, [connectorsControlResetKey]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (!connectorMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const root = connectorRootRef.current;
      if (!root) return;
      if (event.target instanceof Node && !root.contains(event.target)) {
        setConnectorMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [connectorMenuOpen]);

  useEffect(() => {
    if (!connectorMenuOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setConnectorMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [connectorMenuOpen]);

  const slashCommandList = useMemo(
    () => [...slashCommands, ...CORE_SLASH_COMMANDS],
    [slashCommands],
  );

  const skillsForMention = mentionSkills ?? bootstrap.skills;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = value.trim();

    if (trimmed.startsWith("/")) {
      const verb = trimmed.split(/\s+/)[0];
      const match = slashCommandList.find((c) => c.label === verb);
      if (match?.action) {
        onSlashAction?.(match.action);
        setValue("");
        setMenu(null);
        setMenuQuery("");
        return;
      }
    }

    // Only forward attachments that successfully uploaded (status: "ready").
    // Failed / still-uploading ones stay in the composer so the user can
    // retry or remove them. This is what prevents the previous bug where a
    // chip rendered in the bubble but the backend got no attachment.
    const readyAttachments = attachments.filter((a) => a.status === "ready");
    const hasUploading = attachments.some((a) => a.status === "uploading");
    if (hasUploading) return; // wait for upload to finish before sending
    if ((!trimmed && readyAttachments.length === 0) || disabled) return;
    setValue("");
    setAttachments([]);
    setMenu(null);
    setMenuQuery("");
    onSubmit(trimmed, readyAttachments);
  };

  const slashOptions = useMemo<CommandHit[]>(() => {
    const q = menuQuery.toLowerCase();
    return slashCommandList.filter((c) => c.label.toLowerCase().includes(q));
  }, [menuQuery, slashCommandList]);

  const mentionOptions = useMemo<CommandHit[]>(() => {
    const q = menuQuery.toLowerCase();
    const skillHits: CommandHit[] = skillsForMention.map((skill) => ({
      key: `skill-${skill.id}`,
      label: `@${skill.name}`,
      insert: `@${skill.name.replace(/\s+/g, "-")} `,
      hint: skill.owner_team,
    }));
    return skillHits.filter((option) => option.label.toLowerCase().includes(q));
  }, [skillsForMention, menuQuery]);

  const connectors = useMemo(() => {
    const visible = mabelUiVisibleConnectors(bootstrap.connectors);
    return [...visible].sort((a, b) =>
      mabelUiConnectorDisplayName(a.id, a.name).localeCompare(mabelUiConnectorDisplayName(b.id, b.name)),
    );
  }, [bootstrap.connectors]);
  const enabledConnectors = useMemo(
    () => connectors.filter((connector) => connector.enabled !== false),
    [connectors],
  );

  useEffect(() => {
    if (autoRevealConnectors && connectors.length > 0) {
      setConnectorsControlRevealed(true);
    }
  }, [autoRevealConnectors, connectors.length]);

  const expandConnectorStrip = () => {
    setConnectorsControlRevealed(true);
    setConnectorMenuOpen(false);
  };

  const collapseConnectorStrip = () => {
    setConnectorsControlRevealed(false);
    setConnectorMenuOpen(false);
  };

  const toggleConnectorDropdown = () => {
    setConnectorMenuOpen((open) => !open);
  };

  const toggleConnector = async (connectorId: string, enabled: boolean) => {
    setConnectorBusy(connectorId);
    setConnectorError("");
    try {
      await setConnectorEnabled(connectorId, enabled);
      await onConnectorsChanged?.();
    } catch (err) {
      setConnectorError(err instanceof Error ? err.message : "Connector update failed");
    } finally {
      setConnectorBusy(null);
    }
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setValue(next);
    const lower = next.toLowerCase();
    const connectorIntent = /\b(mcp|connector|connectors|tool|tools|integration|integrations)\b/.test(lower);
    if (connectorIntent && connectors.length > 0) {
      setConnectorsControlRevealed(true);
    }

    const caret = event.target.selectionStart;
    const upto = next.slice(0, caret);
    const slashMatch = /(?:^|\s)\/(\S*)$/.exec(upto);
    const mentionMatch = /(?:^|\s)@(\S*)$/.exec(upto);

    if (slashMatch) {
      setMenu("slash");
      setMenuQuery(`/${slashMatch[1]}`);
    } else if (mentionMatch) {
      setMenu("mention");
      setMenuQuery(`@${mentionMatch[1]}`);
    } else {
      setMenu(null);
      setMenuQuery("");
    }
  };

  const acceptOption = (option: CommandHit) => {
    if (option.action) {
      onSlashAction?.(option.action);
      setValue("");
      setMenu(null);
      setMenuQuery("");
      return;
    }
    if (option.insert) {
      const caret = textareaRef.current?.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const after = value.slice(caret);
      const replaced = before.replace(/(?:^|\s)([/@])(\S*)$/, () => ` ${option.insert}`.slice(1));
      setValue(`${replaced}${after}`);
    }
    setMenu(null);
    setMenuQuery("");
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      const options = menu === "slash" ? slashOptions : mentionOptions;
      if (event.key === "Enter" && options[0]) {
        event.preventDefault();
        acceptOption(options[0]);
        return;
      }
      if (event.key === "Escape") {
        setMenu(null);
        setMenuQuery("");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onPickFile = () => fileInputRef.current?.click();

  const onFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const filesRaw = event.target.files;
    if (!filesRaw) return;
    const files: File[] = Array.from(filesRaw as ArrayLike<File>);
    const newlyAttached: AttachedFile[] = [];
    for (const file of files) {
      if (!file) continue;
      newlyAttached.push({
        kind: "local",
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(16).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        file,
        status: "uploading",
      });
    }
    if (newlyAttached.length === 0) return;
    setAttachments((prev) => [...prev, ...newlyAttached]);
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Kick off the upload immediately so the chip transitions to "ready"
    // before the user hits Send. Each file gets its own request so a single
    // failure doesn't drag the whole batch down.
    for (const item of newlyAttached) {
      if (item.kind !== "local") continue;
      void uploadMabelFiles([item.file])
        .then((rows) => {
          const remote = rows[0];
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === item.id
                ? { ...a, status: "ready", uploadedId: remote?.id }
                : a,
            ),
          );
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[mabel] upload failed for", item.name, "—", message);
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === item.id && a.kind === "local"
                ? { ...a, status: "error", error: message }
                : a,
            ),
          );
        });
    }
  };

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((file) => file.id !== id));

  const hasUploadingFile = attachments.some((a) => a.status === "uploading");
  const hasUsableContent =
    value.trim().length > 0 || attachments.some((a) => a.status === "ready");
  const canSend = hasUsableContent && !disabled && !hasUploadingFile;
  const showMenu = menu !== null && (menu === "slash" ? slashOptions.length > 0 : mentionOptions.length > 0);

  return (
    <form className="mabel-composer" onSubmit={submit}>
      {contextLabel ? (
        <div className="mabel-composer__context" aria-label={`Project context: ${contextLabel}`}>
          <ProjectsNavIcon size={12} />
          <span>Project</span>
          <strong>{contextLabel}</strong>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mabel-composer__attachments">
          {attachments.map((file) => (
            <span
              key={file.id}
              className={`mabel-composer__chip mabel-composer__chip--${file.status}`}
              title={file.status === "error" ? `Upload failed: ${file.error || "unknown error"}` : file.name}
            >
              {file.status === "uploading" ? (
                <span className="mabel-composer__chip-spinner" aria-hidden="true" />
              ) : (
                <FileIcon />
              )}
              {file.name}
              {file.status === "uploading" ? (
                <span className="mabel-composer__chip-status">uploading…</span>
              ) : null}
              {file.status === "error" ? (
                <span className="mabel-composer__chip-status mabel-composer__chip-status--error">failed</span>
              ) : null}
              <button
                type="button"
                className="mabel-composer__chip-x"
                onClick={() => removeAttachment(file.id)}
                aria-label={`Remove ${file.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        aria-label="Mabel prompt"
        placeholder="Type / for commands, @ to mention"
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={disabled && !isStreaming}
        rows={1}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={onFiles}
        aria-hidden="true"
      />

      {showMenu ? (
        <div className="mabel-composer__menu" role="listbox" aria-label={menu === "slash" ? "Slash commands" : "Mentions"}>
          {(menu === "slash" ? slashOptions : mentionOptions).map((option) => (
            <button
              key={option.key}
              type="button"
              className="mabel-composer__menu-item"
              onClick={() => acceptOption(option)}
              role="option"
              aria-selected={false}
            >
              <span className="mabel-composer__menu-label">{option.label}</span>
              {option.hint ? <span className="mabel-composer__menu-hint">{option.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mabel-composer-actions">
        <div className="mabel-composer-actions__left">
          <button
            type="button"
            className="mabel-icon-btn"
            onClick={onPickFile}
            disabled={disabled}
            aria-label="Attach files"
            title="Attach files"
          >
            <PlusIcon />
          </button>
          <div className="mabel-composer-connectors" ref={connectorRootRef}>
            {connectorsControlRevealed ? (
              <div
                className={`mabel-composer-connectors__shell mabel-composer-connectors__shell--revealed${
                  connectorMenuOpen ? " mabel-composer-connectors__shell--open" : ""
                }`}
              >
                <button
                  type="button"
                  className="mabel-composer-connectors__engage"
                  onClick={collapseConnectorStrip}
                  disabled={connectorBusy !== null || connectors.length === 0}
                  aria-label="Turn off Connectors"
                  title="Hide Connectors — icon only until you turn it on again"
                >
                  <span className="mabel-composer-connectors__control-icon" aria-hidden="true">
                    <McpIcon />
                  </span>
                  <span className="mabel-composer-connectors__control-label">Connectors</span>
                </button>
                <span className="mabel-composer-connectors__split" aria-hidden="true" />
                <button
                  type="button"
                  className="mabel-composer-connectors__dropdown"
                  onClick={toggleConnectorDropdown}
                  disabled={connectorBusy !== null || connectors.length === 0}
                  aria-expanded={connectorMenuOpen}
                  aria-haspopup="true"
                  aria-controls={connectorMenuOpen ? "mabel-composer-connectors-menu" : undefined}
                  aria-label={
                    connectorMenuOpen
                      ? "Close MCP connector list"
                      : enabledConnectors.length > 0
                        ? `Open MCP connector list, ${enabledConnectors.length} on`
                        : "Open MCP connector list"
                  }
                  title={
                    enabledConnectors.length <= 8
                      ? enabledConnectors.map((c) => mabelUiConnectorDisplayName(c.id, c.name)).join(", ") || "Choose which MCP connectors are on"
                      : `${enabledConnectors.slice(0, 6).map((c) => c.name).join(", ")}… +${enabledConnectors.length - 6} more`
                  }
                >
                  <span
                    className={`mabel-composer-connectors__control-chevron${
                      connectorMenuOpen ? " mabel-composer-connectors__control-chevron--open" : ""
                    }`}
                    aria-hidden="true"
                  >
                    <ChevronDownIcon />
                  </span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="mabel-composer-connectors__control mabel-composer-connectors__control--collapsed"
                onClick={expandConnectorStrip}
                disabled={connectorBusy !== null || connectors.length === 0}
                aria-label={
                  enabledConnectors.length > 0
                    ? `Connectors — ${enabledConnectors.length} on, show toolbar`
                    : "Connectors — show toolbar"
                }
                title="Show Connectors — then use the arrow to pick MCPs"
              >
                <span className="mabel-composer-connectors__control-icon" aria-hidden="true">
                  <McpIcon />
                </span>
              </button>
            )}
            {connectorMenuOpen ? (
              <div
                id="mabel-composer-connectors-menu"
                className="mabel-composer-connectors__menu"
                role="list"
                aria-label="MCP connector toggles"
              >
                {connectorError ? <div className="mabel-composer-connectors__error">{connectorError}</div> : null}
                {connectors.length === 0 ? (
                  <p className="mabel-composer-connectors__empty">No MCP connectors are available yet.</p>
                ) : (
                  connectors.map((connector) => {
                    const checked = connector.enabled !== false;
                    const safeId = connector.id.replace(/[^a-zA-Z0-9_-]/g, "-");
                    const toggleAllowed = mabelUiConnectorToggleAllowed(connector.id);
                    return (
                      <div
                        key={connector.id}
                        className={`mabel-composer-connectors__row${toggleAllowed ? "" : " mabel-composer-connectors__row--locked"}`}
                        role="listitem"
                        title={toggleAllowed ? undefined : "This connector is managed outside Mabel for now"}
                        onClick={(event) => {
                          if (connectorBusy !== null || !toggleAllowed) return;
                          if (
                            (event.target as HTMLElement).closest(".mabel-composer-connectors__switch")
                          ) {
                            return;
                          }
                          void toggleConnector(connector.id, !checked);
                        }}
                      >
                        <span className="mabel-composer-connectors__name" id={`mabel-mcp-label-${safeId}`}>
                          {mabelUiConnectorDisplayName(connector.id, connector.name)}
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={checked}
                          aria-labelledby={`mabel-mcp-label-${safeId}`}
                          className="mabel-composer-connectors__switch"
                          disabled={connectorBusy !== null || !toggleAllowed}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!toggleAllowed) return;
                            void toggleConnector(connector.id, !checked);
                          }}
                        />
                      </div>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
        </div>
        <div className="mabel-composer-actions__right">
          <span className="mabel-composer-hint">Shift + Return for new line</span>
          {isStreaming ? (
            <button type="button" className="mabel-send-btn mabel-send-btn--stop" onClick={onStop} aria-label="Stop generating">
              <StopIcon />
            </button>
          ) : (
            <button type="submit" className="mabel-send-btn" disabled={!canSend} aria-label="Send message">
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function McpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="5.5" r="2.15" />
      <circle cx="6.25" cy="16" r="2.15" />
      <circle cx="17.75" cy="16" r="2.15" />
      <path d="M10.35 7.15 7.55 13.55M13.65 7.15l2.8 6.4M9.35 16h5.3" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
