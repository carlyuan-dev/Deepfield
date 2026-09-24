import { Fragment, type RefObject } from "react";
import type { ChatCapabilityConfirmation, ChatCapabilityOperationCard, ChatCapabilityTaskCard, InteractionRecord, RespondCommand } from "@deepfield/contracts";
import type { DraftRef, ViewRef } from "@deepfield/capability-sdk";
import type { ChatMessageView } from "../state/chat.js";
import { LinkifiedText } from "./LinkifiedText.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { ToolActivity } from "./ToolActivity.js";
import { CapabilityChatCards } from "./CapabilityChatCards.js";
import { ChatInteractionCard } from "./ChatInteractionCard.js";

export interface MessagesProps {
  messages: ChatMessageView[];
  emptyLabel?: string;
  messagesRef?: RefObject<HTMLDivElement | null>;
  onScroll?(element: HTMLDivElement): void;
  interactionCards?: {
    interactions: InteractionRecord[];
    respond(interaction: InteractionRecord, command: RespondCommand): Promise<InteractionRecord>;
    openEditor?(interaction: InteractionRecord): Promise<void>;
  };
  capabilityCards?: {
    tasks: ChatCapabilityTaskCard[]; confirmations: ChatCapabilityConfirmation[]; operations: ChatCapabilityOperationCard[];
    approve(ref: string, analyzeAfter: boolean): Promise<void>; dismiss(ref: string): Promise<void>;
    open(target: ViewRef | DraftRef): Promise<void>;
  };
}

export function Messages({
  messages,
  emptyLabel = "还没有消息",
  messagesRef,
  onScroll,
  capabilityCards,
  interactionCards,
}: MessagesProps) {
  const owner = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.requestId) return;
    if (message.role === "assistant" || !owner.has(message.requestId)) owner.set(message.requestId, index);
  });
  const interactionsFor = (requestId: string) => interactionCards?.interactions.filter(item => item.requestId === requestId) ?? [];
  const taskFor = (interaction: InteractionRecord) => capabilityCards?.tasks.find(task =>
    task.sourceRequestId === interaction.requestId && task.interactionId === interaction.id);
  const cardsFor = (requestId: string) => <>
    {interactionsFor(requestId).map(item => <ChatInteractionCard key={item.id} interaction={item}
      operation={capabilityCards?.operations.find(operation => operation.interactionId === item.id)} task={taskFor(item)}
      {...(capabilityCards ? { open: capabilityCards.open } : {})}
      respond={command => interactionCards!.respond(item, command)}
      {...(interactionCards?.openEditor ? { openEditor: () => interactionCards.openEditor!(item) } : {})} />)}
    {capabilityCards && <CapabilityChatCards
    tasks={capabilityCards.tasks.filter(item => item.sourceRequestId === requestId && !interactionsFor(requestId).some(interaction => taskFor(interaction) === item))}
    confirmations={interactionsFor(requestId).some(item => item.payload.kind === "approval") ? [] : capabilityCards.confirmations.filter(item => item.sourceRequestId === requestId)}
    operations={capabilityCards.operations.filter(item => item.sourceRequestId === requestId
      && !interactionsFor(requestId).some(interaction => interaction.id === item.interactionId)
      && (item.status !== "awaiting_confirmation" || !interactionsFor(requestId).some(interaction => interaction.payload.kind === "approval")))}
    approve={capabilityCards.approve} dismiss={capabilityCards.dismiss} open={capabilityCards.open} />}
  </>;
  const hasCards = (requestId: string) => Boolean(interactionsFor(requestId).length || (capabilityCards && (
    capabilityCards.confirmations.some(item => item.sourceRequestId === requestId)
    || capabilityCards.operations.some(item => item.sourceRequestId === requestId)
    || capabilityCards.tasks.some(item => item.sourceRequestId === requestId && item.snapshot.presentation))));
  return (
    <div
      ref={messagesRef}
      className="messages"
      aria-live="polite"
      onScroll={(event) => onScroll?.(event.currentTarget)}
    >
      {messages.length === 0 && <p className="messages-empty">{emptyLabel}</p>}
      {messages.map((message, index) => <Fragment key={message.key}>
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
          {message.role === "assistant" && message.requestId && owner.get(message.requestId) === index && cardsFor(message.requestId)}
        </div>
        {message.role === "user" && message.requestId && owner.get(message.requestId) === index && hasCards(message.requestId) &&
          <div className="message assistant capability-message"><div className="message-role">Deepfield</div>{cardsFor(message.requestId)}</div>}
      </Fragment>)}
    </div>
  );
}
