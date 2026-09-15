import type { RefObject } from "react";
import type { ChatMessageView } from "../state/chat.js";
import { LinkifiedText } from "./LinkifiedText.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { ToolActivity } from "./ToolActivity.js";

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
          <div className={`message-role ${message.role === "user" ? "user-message-role" : ""}`}>
            {message.role === "user" ? "我" : "Deepfield"}
          </div>
          {message.role === "assistant" &&
            (message.skillName !== undefined || message.webSearch === true) && (
              <div className="message-badges">
                {message.webSearch === true && (
                  <span className="web-search-badge">联网搜索</span>
                )}
                {message.skillName !== undefined && (
                  <span className="skill-badge">Skill: {message.skillName}</span>
                )}
              </div>
            )}
          {message.role === "assistant" && message.toolActivities.length > 0 && (
            <ToolActivity
              activities={message.toolActivities}
              terminal={message.status !== "streaming"}
            />
          )}
          <div
            className={
              message.role === "assistant"
                ? "message-content assistant-content"
                : "message-content"
            }
          >
            {message.content.length > 0 ? (
              message.role === "assistant" ? (
                <MarkdownMessage content={message.content} />
              ) : (
                <LinkifiedText text={message.content} />
              )
            ) : message.status === "streaming" ? (
              <span className="chat-thinking" role="status" aria-label="Deepfield 正在思考">
                <span className="chat-thinking-spinner" aria-hidden="true" />
                正在思考…
              </span>
            ) : (
              ""
            )}
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
