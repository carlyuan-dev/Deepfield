import type { Conversation } from "@deepfield/contracts";

export type SidebarActive = "chat" | "capability" | "settings" | undefined;
export type ConnectionStatus = "checking" | "connected" | "disconnected";

export interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: string | undefined;
  connectionStatus: ConnectionStatus;
  active: SidebarActive;
  onNewConversation(): void;
  onOpenConversation(conversationId: string): void;
  onDeleteConversation(conversationId: string): void;
  deletionError: string | undefined;
  capabilities: readonly { id: string; title: string }[];
  activeCapability?: string | undefined;
  onOpenCapability(id: string): void;
  onOpenSettings(): void;
}

export function Sidebar({
  conversations,
  activeConversationId,
  connectionStatus,
  active,
  onNewConversation,
  onOpenConversation,
  onDeleteConversation,
  deletionError,
  capabilities,
  activeCapability,
  onOpenCapability,
  onOpenSettings,
}: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="主导航">
      <div className="brand">
        <span>Deepfield</span>
        <span
          className={`connection-indicator ${connectionStatus}`}
          role="status"
          aria-label={
            connectionStatus === "checking"
              ? "模型连接状态：检测中"
              : connectionStatus === "connected"
                ? "模型连接状态：已连接"
                : "模型连接状态：未连接"
          }
          title={
            connectionStatus === "checking"
              ? "DeepSeek：检测中"
              : connectionStatus === "connected"
                ? "DeepSeek：已连接"
                : "DeepSeek：未连接"
          }
        />
      </div>
      <ul className="nav-primary">
        <li>
          <button onClick={onNewConversation}>
            ＋ 新对话
          </button>
        </li>
      </ul>
      <div className="nav-section-title">对话</div>
      <ul className="nav-projects">
        {conversations.map((conversation) => (
          <li key={conversation.id} className="nav-conversation-row">
            <button
              className={`nav-conversation-open ${activeConversationId === conversation.id ? "active" : ""}`}
              aria-current={activeConversationId === conversation.id ? "page" : undefined}
              onClick={() => onOpenConversation(conversation.id)}
            >
              {conversation.title}
            </button>
            <button
              type="button"
              className="nav-conversation-delete"
              aria-label={`删除${conversation.title}`}
              title="删除对话"
              onClick={() => onDeleteConversation(conversation.id)}
            >
              ×
            </button>
          </li>
        ))}
        {conversations.length === 0 && <li className="muted">暂无对话</li>}
      </ul>
      {deletionError !== undefined && <p className="nav-error" role="alert">{deletionError}</p>}
      {capabilities.length > 0 && <div className="nav-section-title">工作流</div>}
      <ul className="nav-primary">
        {capabilities.map(item => <li key={item.id}>
          <button className={active === "capability" && activeCapability === item.id ? "active" : ""} onClick={() => onOpenCapability(item.id)}>
            {item.title}
          </button>
        </li>)}
      </ul>
      <div className="nav-footer">
        <button className={active === "settings" ? "active" : ""} onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </nav>
  );
}
