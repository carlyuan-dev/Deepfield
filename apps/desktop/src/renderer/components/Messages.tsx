import type { ChatMessageView } from "../state/chat.js";

export interface MessagesProps {
  messages: ChatMessageView[];
  emptyLabel?: string;
}

export function Messages({ messages, emptyLabel = "还没有消息" }: MessagesProps) {
  return (
    <div className="messages" aria-live="polite">
      {messages.length === 0 && <p className="messages-empty">{emptyLabel}</p>}
      {messages.map((message) => (
        <div key={message.key} className={`message ${message.role} ${message.status}`}>
          <div className="message-role">{message.role === "user" ? "我" : "Deepfield"}</div>
          <div className="message-content">
            {message.content.length > 0 ? message.content : message.status === "streaming" ? "…" : ""}
          </div>
          {message.status === "failed" && (
            <p className="message-error" role="alert">
              回复失败，请重试
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
