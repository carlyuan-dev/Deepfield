import type { DesktopApi } from "@deepfield/contracts";
import { useChat } from "../state/use-chat.js";
import { visibleMessages } from "../state/chat.js";
import { Composer } from "./Composer.js";
import { Messages } from "./Messages.js";

export interface ChatRailProps {
  api: DesktopApi;
  projectId: string | undefined;
  collapsed: boolean;
  onCollapse(): void;
  onExpand(): void;
}

export function ChatRail({ api, projectId, collapsed, onCollapse, onExpand }: ChatRailProps) {
  // Keep the chat controller mounted while collapsed so an in-flight request
  // keeps streaming into its draft without being interrupted.
  const { state, submit } = useChat(api, projectId);

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
      {projectId === undefined ? (
        <p className="muted rail-hint">创建项目后可在右侧继续 Chat。</p>
      ) : (
        <>
          <Messages messages={visibleMessages(state)} />
          <Composer
            disabled={state.sending || state.loadState !== "ready"}
            onSubmit={submit}
            placeholder="输入消息…"
          />
        </>
      )}
    </aside>
  );
}
