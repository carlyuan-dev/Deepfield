export interface ChatPaneHeaderProps {
  title: string;
  paneState: "expanded" | "collapsed";
  capabilityOpen: boolean;
  onToggle(): void;
}

export function ChatPaneHeader({
  title,
  paneState,
  capabilityOpen,
  onToggle,
}: ChatPaneHeaderProps) {
  return (
    <header className={`chat-pane-header ${paneState}`} aria-label="Chat 顶栏">
      <div className="chat-pane-title">{title}</div>
      {capabilityOpen && (
        <button
          className="chat-pane-toggle"
          aria-label={paneState === "expanded" ? "收起 Chat" : "展开 Chat"}
          onClick={onToggle}
        >
          {paneState === "expanded" ? "‹" : "›"}
        </button>
      )}
    </header>
  );
}
