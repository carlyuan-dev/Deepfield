import type { RefObject } from "react";
import type { ChatMessageView } from "../state/chat.js";

export interface MessagesProps {
  messages: ChatMessageView[];
  emptyLabel?: string;
  messagesRef?: RefObject<HTMLDivElement | null>;
  onScroll?(element: HTMLDivElement): void;
}

export function Messages({
  messages,
  emptyLabel = "还没有消息",
  messagesRef,
  onScroll,
}: MessagesProps) {
  return (
    <div
      ref={messagesRef}
      className="messages"
      aria-live="polite"
      onScroll={(event) => onScroll?.(event.currentTarget)}
    >
      {messages.length === 0 && <p className="messages-empty">{emptyLabel}</p>}
      {messages.map((message) => (
        <div key={message.key} className={`message ${message.role} ${message.status}`}>
          <div className="message-role">{message.role === "user" ? "我" : "Deepfield"}</div>
          {message.role === "assistant" && message.skillName !== undefined && (
            <div className="skill-badge">Skill: {message.skillName}</div>
          )}
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
