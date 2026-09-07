import type { Conversation } from "@deepfield/contracts";

export type SidebarActive = "chat" | "capability" | "settings" | undefined;

export interface SidebarProps {
  conversations: Conversation[];
  active: SidebarActive;
  onNewConversation(): void;
  onOpenConversation(conversationId: string): void;
  onOpenResearch(): void;
  onOpenSettings(): void;
}

export function Sidebar({
  conversations,
  active,
  onNewConversation,
  onOpenConversation,
  onOpenResearch,
  onOpenSettings,
}: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="主导航">
      <div className="brand">Deepfield</div>
      <ul className="nav-primary">
        <li>
          <button className={active === "chat" ? "active" : ""} onClick={onNewConversation}>
            ＋ 新对话
          </button>
        </li>
      </ul>
      <div className="nav-section-title">对话</div>
      <ul className="nav-projects">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <button onClick={() => onOpenConversation(conversation.id)}>
              {conversation.title}
            </button>
          </li>
        ))}
        {conversations.length === 0 && <li className="muted">暂无对话</li>}
      </ul>
      <div className="nav-section-title">工作流</div>
      <ul className="nav-primary">
        <li>
          <button className={active === "capability" ? "active" : ""} onClick={onOpenResearch}>
            行业研究
          </button>
        </li>
      </ul>
      <div className="nav-footer">
        <button className={active === "settings" ? "active" : ""} onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </nav>
  );
}
