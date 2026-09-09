export interface WebSearchToggleProps {
  enabled: boolean;
  disabled: boolean;
  onChange(enabled: boolean): void;
}

export function WebSearchToggle({ enabled, disabled, onChange }: WebSearchToggleProps) {
  return (
    <button
      type="button"
      className={`web-search-toggle${enabled ? " active" : ""}`}
      aria-label="联网搜索"
      aria-pressed={enabled}
      disabled={disabled}
      title={enabled ? "联网搜索已开启" : "开启联网搜索"}
      onClick={() => onChange(!enabled)}
    >
      ◉ 联网
    </button>
  );
}
