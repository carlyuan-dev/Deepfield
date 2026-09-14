import type { Conversation } from "@deepfield/contracts";

export type SidebarActive = "chat" | "capability" | "settings" | undefined;
export type ConnectionStatus = "checking" | "connected" | "disconnected";

export interface SidebarProps {
  conversations: Conversation[];
  activeConversationId: string | undefined;
  connectionStatus: ConnectionStatus;
  active: SidebarActive;
  mode?: "main" | "settings";
  onNewConversation(): void;
  onOpenConversation(conversationId: string): void;
  onDeleteConversation(conversationId: string): void;
  deletionError: string | undefined;
  onOpenResearch(): void;
  onOpenSettings(): void;
  onBackFromSettings(): void;
}

export function Sidebar({
  conversations,
  activeConversationId,
  connectionStatus,
  active,
  mode = "main",
  onNewConversation,
  onOpenConversation,
  onDeleteConversation,
  deletionError,
  onOpenResearch,
  onOpenSettings,
  onBackFromSettings,
}: SidebarProps) {
  if (mode === "settings") {
    return (
      <nav className="sidebar settings-sidebar" aria-label="设置导航">
        <button className="brand sidebar-back" onClick={onBackFromSettings}>
          ‹ 返回
        </button>
        <div className="nav-section-title">设置</div>
        <ul className="nav-primary">
          <li>
            <button className="active" aria-current="page">
              模型与密钥
            </button>
          </li>
        </ul>
      </nav>
    );
  }

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
      <div className="nav-section-title">工作流</div>
      <ul className="nav-primary">
        <li>
          <button className={active === "capability" ? "active" : ""} onClick={onOpenResearch}>
            研究主题
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
