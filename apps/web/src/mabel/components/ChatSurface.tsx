import { PromptComposer } from "./PromptComposer";
import { ToolTimeline } from "./ToolTimeline";
import { useMabelStream } from "../hooks/useMabelStream";
import type { MabelBootstrap, MabelSurface } from "../types";

type ChatSurfaceProps = {
  surface: MabelSurface;
};

export function ChatSurface({ surface }: ChatSurfaceProps) {
  const { messages, toolEvents, isStreaming, error, send } = useMabelStream(surface);
  const emptyBootstrap: MabelBootstrap = {
    surfaces: ["chat", "rag", "mcp", "agents"],
    connectors: [],
    skills: [],
    starter_packs: [],
    approvals: [],
  };

  return (
    <div className="mabel-chat-grid">
      <section className="mabel-chat-card" aria-label="Mabel chat">
        <div className="mabel-message-list">
          {messages.map((message) => (
            <article key={message.id} className={`mabel-message mabel-message--${message.role}`}>
              <span>{message.role}</span>
              <p>{message.content || (message.role === "assistant" ? "Thinking..." : "")}</p>
            </article>
          ))}
        </div>
        {error ? <div className="mabel-error">{error}</div> : null}
        <PromptComposer
          disabled={isStreaming}
          isStreaming={isStreaming}
          bootstrap={emptyBootstrap}
          onSubmit={(message, attachments) => {
            void send(message, {
              attachmentIds: attachments.map((item) => item.uploadedId).filter(Boolean) as string[],
            });
          }}
        />
      </section>
      <ToolTimeline events={toolEvents} />
    </div>
  );
}
