import type { MabelConversationSummary } from "../types";

type RecentSessionsProps = {
  label: string;
  conversationIds: number[];
  conversations: MabelConversationSummary[];
  onOpen: (conversationId: number) => void;
  emptyText?: string;
};

export function RecentSessions({ label, conversationIds, conversations, onOpen, emptyText }: RecentSessionsProps) {
  const known = conversationIds
    .map((id) => conversations.find((c) => c.id === id))
    .filter((c): c is MabelConversationSummary => c !== undefined);

  if (known.length === 0 && !emptyText) return null;

  return (
    <div className="mabel-page__sessions">
      <div className="mabel-page__sessions-head">{label}</div>
      {known.length === 0 ? (
        <p className="mabel-muted">{emptyText}</p>
      ) : (
        <ul className="mabel-page__sessions-list">
          {known.slice(0, 6).map((conversation) => (
            <li key={conversation.id}>
              <button type="button" className="mabel-page__session" onClick={() => onOpen(conversation.id)}>
                <span className="mabel-page__session-title">
                  {conversation.title.length > 60 ? `${conversation.title.slice(0, 57)}…` : conversation.title}
                </span>
                <span className="mabel-page__session-meta">
                  {formatRelativeTime(conversation.updated_at)} · {conversation.message_count} msg
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
