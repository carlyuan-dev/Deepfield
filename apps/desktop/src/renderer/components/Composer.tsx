export interface ComposerProps {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  onSubmit(content: string): void;
  placeholder?: string;
}

export function Composer({
  value,
  onChange,
  disabled,
  onSubmit,
  placeholder = "输入消息…",
}: ComposerProps) {
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
      />
      <div className="composer-actions">
        <button type="submit" disabled={disabled || value.trim().length === 0}>
          发送
        </button>
      </div>
    </form>
  );
}
