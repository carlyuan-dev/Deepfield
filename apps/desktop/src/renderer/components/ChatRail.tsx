import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "@deepfield/contracts";
import { useChat } from "../state/use-chat.js";
import type { ChatEventHub } from "../state/chat-event-hub.js";
import { visibleMessages } from "../state/chat.js";
import { Composer } from "./Composer.js";
import { Messages } from "./Messages.js";

export interface ChatRailProps {
  api: DesktopApi;
  eventHub: ChatEventHub;
  requestIdFactory: () => string;
  projectId: string | undefined;
  collapsed: boolean;
  onCollapse(): void;
  onExpand(): void;
}

export function ChatRail({
  api,
  eventHub,
  requestIdFactory,
  projectId,
  collapsed,
  onCollapse,
  onExpand,
}: ChatRailProps) {
  // Keep the chat controller mounted while collapsed so an in-flight request
  // keeps streaming into its draft without being interrupted.
  const { state, submit, reload } = useChat(api, projectId, eventHub, requestIdFactory);
  const [draft, setDraft] = useState("");
  const lastSubmitted = useRef("");

  useEffect(() => {
    if (state.sendError !== undefined && lastSubmitted.current.length > 0) {
      setDraft(lastSubmitted.current);
    }
  }, [state.sendError]);

  if (collapsed) {
    return (
      <aside className="chat-rail collapsed" aria-label="Chat 侧栏（已收起）">
        <button aria-label="展开 Chat 侧栏" onClick={onExpand}>
          ›
        </button>
      </aside>
    );
  }

  return (
    <aside className="chat-rail" aria-label="Chat 侧栏">
      <header className="rail-header">
        <span>Chat</span>
        <button aria-label="收起 Chat 侧栏" onClick={onCollapse}>
          ‹
        </button>
      </header>
      {state.loadState === "error" && (
        <div className="error" role="alert">
          {state.loadError}
          <button onClick={reload}>重新加载</button>
        </div>
      )}
      {state.sendError !== undefined && (
        <p className="error" role="alert">
          {state.sendError}
        </p>
      )}
      {projectId === undefined ? (
        <p className="muted rail-hint">创建项目后可在右侧继续 Chat。</p>
      ) : (
        <>
          <Messages messages={visibleMessages(state)} />
          <Composer
            value={draft}
            onChange={setDraft}
            disabled={state.sending || state.loadState !== "ready"}
            onSubmit={(content) => {
              lastSubmitted.current = content;
              setDraft("");
              submit(content, { webSearch: false });
            }}
            placeholder="输入消息…"
          />
        </>
      )}
    </aside>
  );
}
