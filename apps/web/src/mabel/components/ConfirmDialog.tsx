import { useEffect } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div className="mabel-modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="mabel-modal__backdrop" onClick={onCancel} aria-hidden="true" />
      <div className="mabel-modal__panel mabel-modal__panel--sm">
        <header className="mabel-modal__head">
          <h2>{title}</h2>
        </header>
        {body ? (
          <section className="mabel-modal__section">
            <p className="mabel-muted mabel-modal__body">{body}</p>
          </section>
        ) : null}
        <footer className="mabel-modal__foot mabel-modal__foot--split">
          <button type="button" className="mabel-button mabel-button--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`mabel-button${destructive ? " mabel-button--danger" : ""}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
