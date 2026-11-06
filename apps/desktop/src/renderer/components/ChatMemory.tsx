import { useEffect, useState } from "react";
import type { MemoryDashboard, MemoryManagementApi } from "@deepfield/contracts";
import "./chat-memory.css";

export function useMemoryState(api?: MemoryManagementApi) {
  const [state, setState] = useState<MemoryDashboard>();
  useEffect(() => {
    let active = true;
    const refresh = () => { void api?.get().then(value => { if (active) setState(value); }, () => {}); };
    refresh(); const unsubscribe = api?.onChanged(refresh);
    return () => { active = false; unsubscribe?.(); };
  }, [api]);
  return { state, acknowledge: () => api?.configure({ noticeSeen: true }).then(setState) };
}
export function MemoryNotice({ acknowledge, open }: { acknowledge(): Promise<unknown> | undefined; open?: (() => void) | undefined }) {
  const [error, setError] = useState(false);
  return <aside className="chat-memory-notice" aria-label="记忆说明">
    <span>记忆已开启：仅从新交互学习用户背景与偏好，保存在本机。提炼会调用当前模型并计入用量。</span>
    <div>{open && <button type="button" onClick={open}>记忆设置</button>}<button type="button" onClick={() => { void acknowledge()?.catch(() => setError(true)); }}>知道了</button></div>
    {error && <small role="alert">未能保存，请重试。</small>}
  </aside>;
}
