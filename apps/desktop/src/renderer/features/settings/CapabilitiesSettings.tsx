import { useState } from "react";
import type { CapabilityManagementApi } from "@deepfield/contracts";
import { useCapabilities } from "../../capabilities/use-capabilities.js";

const statusLabels: Record<string, string> = { ready: "可用", disabled: "未启用", loading: "启动中", incompatible: "不兼容", failed: "不可用" };
export function CapabilitiesSettings({ api }: { api: CapabilityManagementApi }) {
  const { snapshot, error } = useCapabilities(api);
  const [pending, setPending] = useState<string>();
  const [message, setMessage] = useState<string>();
  return <>
    <header className="settings-header"><div><h2>能力</h2><p>选择下次启动时启用的能力，当前运行状态保持不变。</p></div></header>
    {error && <p role="alert">无法读取能力列表</p>}
    {!snapshot && !error && <p>加载能力…</p>}
    {snapshot?.packages.length === 0 && <p>暂无已安装能力</p>}
    {snapshot?.issues.map((issue, i) => <p role="alert" key={i}>{issue.code} · {issue.message}</p>)}
    {snapshot?.packages.map(item => <section key={item.id} className="capability-setting">
      <h3>{item.name} <small>{item.version}</small></h3><p>{item.description}</p>
      <p>当前状态：{statusLabels[item.status]}</p>
      {item.issue && <p role="alert">{item.issue.code} · {item.issue.message}</p>}
      <label><input type="checkbox" checked={item.enabledNextStart} disabled={pending !== undefined} onChange={event => {
        setPending(item.id); setMessage(undefined);
        void api.setEnabled(item.id, event.target.checked).then(() => setMessage("下次启动生效"), () => setMessage("无法保存能力设置，请重试")).finally(() => setPending(undefined));
      }} />下次启动启用{item.name}</label>
    </section>)}
    {message && <p role="status">{message}</p>}
  </>;
}
