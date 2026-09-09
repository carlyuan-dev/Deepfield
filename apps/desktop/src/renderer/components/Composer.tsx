import { useRef, type ReactNode } from "react";

export interface ComposerProps {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  onSubmit(content: string): void;
  placeholder?: string;
  /** Optional controls rendered at the leading edge of the actions row. */
  actions?: ReactNode;
}

export function Composer({
  value,
  onChange,
  disabled,
  onSubmit,
  placeholder = "输入消息…",
  actions,
}: ComposerProps) {
  const composing = useRef(false);
  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) {
      return;
    }
    onSubmit(trimmed);
    onChange("");
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label="消息输入"
        rows={3}
        disabled={disabled}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !composing.current) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-actions">
        {actions !== undefined && <div className="composer-actions-leading">{actions}</div>}
        <button type="submit" disabled={disabled || value.trim().length === 0}>
          发送
        </button>
      </div>
    </form>
  );
}
