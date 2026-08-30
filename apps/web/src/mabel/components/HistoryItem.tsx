import { useEffect, useRef, useState } from "react";

type HistoryItemProps = {
  conversationId: number;
  title: string;
  isActive?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onSelect: () => void;
  onRename: (next: string) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
};

export function HistoryItem({ title, isActive, disabled, loading, onSelect, onRename, onDelete }: HistoryItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  if (editing) {
    return (
      <div className="mabel-history-item-row" ref={rootRef}>
        <input
          className="mabel-history-item__input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={async () => {
            const trimmed = draft.trim();
            if (trimmed && trimmed !== title) {
              await onRename(trimmed);
            }
            setEditing(false);
          }}
          onKeyDown={async (event) => {
            if (event.key === "Enter") {
              const trimmed = draft.trim();
              if (trimmed && trimmed !== title) {
                await onRename(trimmed);
              }
              setEditing(false);
            } else if (event.key === "Escape") {
              setDraft(title);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`mabel-history-item-row${isActive ? " mabel-history-item-row--active" : ""}${menuOpen ? " mabel-history-item-row--menu" : ""}${loading ? " mabel-history-item-row--loading" : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="mabel-history-item"
        onClick={onSelect}
        disabled={disabled || loading}
      >
        <span className="mabel-history-item__label">
          {loading ? "Loading…" : title.length > 48 ? `${title.slice(0, 45)}...` : title}
        </span>
        {loading ? <span className="mabel-history-item__spinner" aria-hidden="true" /> : null}
      </button>
      {!disabled ? (
        <button
          type="button"
          className="mabel-history-item__menu-btn"
          aria-label={`Conversation menu for ${title}`}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((v) => !v);
          }}
        >
          <DotsIcon />
        </button>
      ) : null}
      {menuOpen ? (
        <div className="mabel-history-item__menu" role="menu">
          <button
            type="button"
            className="mabel-history-item__menu-item"
            onClick={() => {
              setMenuOpen(false);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="mabel-history-item__menu-item mabel-history-item__menu-item--danger"
            onClick={async () => {
              setMenuOpen(false);
              await onDelete();
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
