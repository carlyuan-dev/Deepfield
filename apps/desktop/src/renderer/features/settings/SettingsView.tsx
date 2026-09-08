import { useEffect, useState } from "react";
import type { DesktopApi } from "@deepfield/contracts";

export interface SettingsViewProps {
  api: DesktopApi;
  onBack(): void;
  onKeySaved(): void;
}

export function SettingsView({ api, onBack, onKeySaved }: SettingsViewProps) {
  const [configured, setConfigured] = useState<boolean>();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.settings.hasDeepSeekKey().then(
      (has) => {
        if (!cancelled) {
          setConfigured(has);
        }
      },
      () => {
        if (!cancelled) {
          setConfigured(false);
          setError("无法读取设置，请重试");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const save = async (): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError("请输入 API Key");
      return;
    }
    if (saving) {
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await api.settings.setDeepSeekKey(trimmed);
      setValue("");
      setConfigured(true);
      onKeySaved();
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-view" aria-label="设置">
      <header className="settings-header">
        <h2>设置</h2>
        <button onClick={onBack}>返回</button>
      </header>
      <div className="setting-row">
        <div className="setting-label">DeepSeek API Key</div>
        <div className="setting-status">
          {configured === undefined
            ? "检测中…"
            : configured
              ? "已配置"
              : "未配置"}
        </div>
      </div>
      {error !== undefined && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className="key-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          API Key
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            placeholder="输入新的 API Key"
          />
        </label>
        <button type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </form>
    </section>
  );
}
