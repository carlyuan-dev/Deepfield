import { useState } from "react";

export interface ComposerProps {
  disabled: boolean;
  onSubmit(content: string): void;
  placeholder?: string;
}

export function Composer({ disabled, onSubmit, placeholder = "输入消息…" }: ComposerProps) {
  const [value, setValue] = useState("");

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) {
      return;
    }
    onSubmit(trimmed);
    setValue("");
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
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label="消息输入"
        rows={3}
      />
      <div className="composer-actions">
        <button type="submit" disabled={disabled || value.trim().length === 0}>
          发送
        </button>
      </div>
    </form>
  );
}
