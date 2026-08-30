import { useEffect } from "react";

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  systemPrompt: string;
  onSystemPromptChange: (next: string) => void;
};

export function SettingsModal({
  open,
  onClose,
  theme,
  onThemeChange,
  systemPrompt,
  onSystemPromptChange,
}: SettingsModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="mabel-modal" role="dialog" aria-modal="true" aria-label="Mabel settings">
      <div className="mabel-modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="mabel-modal__panel">
        <header className="mabel-modal__head">
          <h2>Settings</h2>
          <button type="button" className="mabel-icon-btn" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <section className="mabel-modal__section">
          <label className="mabel-field">
            <span>Theme</span>
            <div className="mabel-segment">
              <button
                type="button"
                className={`mabel-segment__option${theme === "light" ? " mabel-segment__option--active" : ""}`}
                onClick={() => onThemeChange("light")}
              >
                Light
              </button>
              <button
                type="button"
                className={`mabel-segment__option${theme === "dark" ? " mabel-segment__option--active" : ""}`}
                onClick={() => onThemeChange("dark")}
              >
                Dark
              </button>
            </div>
          </label>

          <label className="mabel-field">
            <span>System prompt</span>
            <textarea
              rows={6}
              value={systemPrompt}
              onChange={(event) => onSystemPromptChange(event.target.value)}
              placeholder="Optional instructions Mabel should follow on every new run."
            />
          </label>
        </section>

        <footer className="mabel-modal__foot">
          <button type="button" className="mabel-button" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
