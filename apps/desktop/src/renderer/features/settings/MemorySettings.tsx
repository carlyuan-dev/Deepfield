import { useCallback, useEffect, useState } from "react";
import type { MemoryDashboard, MemoryDetail, MemoryManagementApi, MemorySettings } from "@deepfield/contracts";
import type { MemoryRecord } from "@deepfield/base/memory";
import "./memory-settings.css";

const origin = { user_explicit: "主动记住", user_edited: "手动修改", auto_extracted: "自动学习", consumer_confirmed: "能力保存" };
const scopeLabel = (record: MemoryRecord | MemoryDashboard["records"][number]) => record.scope.namespace === "chat"
  ? record.scope.scopeKey === "user" ? "用户通用" : "会话约定" : "能力偏好";
const time = (value: number) => new Date(value).toLocaleString("zh-CN", { hour12: false });

export function MemorySettingsView({ api }: { api: MemoryManagementApi | undefined }) {
  const [dashboard, setDashboard] = useState<MemoryDashboard>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [selected, setSelected] = useState<MemoryDetail>();
  const [content, setContent] = useState("");
  const [summary, setSummary] = useState("");
  const [applicability, setApplicability] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!api) return;
    try { setDashboard(await api.get(query)); } catch { setError("无法读取记忆，请重试。"); }
  }, [api, query]);
  useEffect(() => { void load(); return api?.onChanged(() => { void load(); }); }, [api, load]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await work(); await load(); } catch { setError("操作未完成，内容可能已更新。你的输入仍保留，可重新打开最新条目后再修改。"); }
    finally { setBusy(false); }
  };
  const open = async (id: string) => {
    if (!api) return;
    try {
      const value = await api.read(id); setSelected(value); setContent(value.record.content); setSummary(value.record.summary); setApplicability(value.record.applicability); setError("");
    } catch { setError("条目不可读取，可能已被删除。请刷新列表。"); }
  };
  const toggle = (patch: Partial<MemorySettings>) => {
    setDashboard(previous => previous ? { ...previous, settings: { ...previous.settings, ...patch } } : previous);
    void run(async () => {
      try { setDashboard(await api!.configure(patch)); }
      catch (error) { await load(); throw error; }
    });
  };
  const visible = dashboard?.records.filter(record => scope === "inactive" ? ["expired", "superseded"].includes(record.status)
    : scope === "conflicted" ? record.status === "conflicted"
    : record.status === "active" && (scope === "all" || scopeLabel(record) === scope));
  return <div className="memory-settings">
    <header className="settings-header"><div><h2>记忆</h2><p>保存偏好与约定，让后续相关对话少一点重复说明。</p></div></header>
    <p className="muted">记忆保存在本机，相关内容会随请求发送给当前模型。删除记忆保留原对话；如需移除原文，请另行删除对话。</p>
    {!api && <p role="alert">记忆服务暂不可用，请重启应用。</p>}
    {dashboard && <>
      <div className="memory-switches">
        <label><input type="checkbox" checked={dashboard.settings.useEnabled} disabled={busy || !dashboard.available} onChange={event => toggle({ useEnabled: event.target.checked })}/><span><strong>使用已保存的记忆</strong><small>在相关请求中参考；关闭后从下一次模型调用起停止使用。</small></span></label>
        <label><input type="checkbox" checked={dashboard.settings.autoLearnEnabled} disabled={busy || !dashboard.available} onChange={event => toggle({ autoLearnEnabled: event.target.checked })}/><span><strong>自动学习新记忆</strong><small>仅学习新交互。累计 4 条用户消息、空闲 60 秒后有界提炼，使用当前模型并计入用量。</small></span></label>
      </div>
      {(error || dashboard.error) && <div className="memory-error" role="alert"><span>{error || dashboard.error}</span>{error
        ? <button type="button" disabled={busy} onClick={() => { setError(""); void load(); }}>刷新列表</button>
        : <button type="button" disabled={busy} onClick={() => void run(() => api!.retry())}>重试提炼</button>}</div>}
      <div className="memory-toolbar">
        <input aria-label="搜索记忆" placeholder="搜索记忆" value={query} onChange={event => setQuery(event.target.value)}/>
        <select aria-label="记忆范围" value={scope} onChange={event => setScope(event.target.value)}>{["all", "用户通用", "会话约定", "能力偏好", "conflicted", "inactive"].map(value => <option key={value} value={value}>{value === "all" ? "全部范围" : value === "conflicted" ? "待处理冲突" : value === "inactive" ? "已失效" : value}</option>)}</select>
        <button type="button" disabled={busy} onClick={() => void load()}>刷新</button>
        <button type="button" disabled={busy || !dashboard.records.length} onClick={() => { if (window.confirm("清空全部保存的记忆和历史版本？原对话保留，后续只学习新的交互。")) void run(async () => { await api!.clear(); setSelected(undefined); }); }}>清空全部</button>
      </div>
      <div className={`memory-layout ${selected ? "with-editor" : ""}`}>
        <div className="memory-list" aria-label="记忆列表">{visible?.length === 0 && <p className="muted">{query ? "没有匹配的记忆。" : "暂无记忆。你可以在 Chat 中说“记住我是做 Agent 开发的”"}</p>}
          {visible?.map(record => <button type="button" key={record.id} className={`memory-row ${selected?.record.id === record.id ? "selected" : ""}`} onClick={() => void open(record.id)}>
            <strong>{record.summary}</strong><span>{scopeLabel(record)} · {origin[record.origin]} · {time(record.updatedAt)}{record.status === "conflicted" ? " · 待处理冲突" : record.status !== "active" ? " · 已失效" : ""}</span>
            {record.applicability && <small>{record.applicability}</small>}
          </button>)}
        </div>
        {selected && <form className="memory-editor" onSubmit={event => { event.preventDefault(); void run(async () => {
          const record = await api!.save(selected.record.id, selected.record.revision, { kind: selected.record.kind, summary, content, applicability });
          setSelected(await api!.read(record.id));
        }); }}>
          <header><strong>{selected.record.status === "conflicted" ? "核对冲突记忆" : "编辑记忆"}</strong><button type="button" onClick={() => setSelected(undefined)}>关闭</button></header>
          {selected.record.status === "conflicted" && <p className="muted">这条记忆尚未用于回答。核对内容后保存，即可保留此条；不需要的条目可以删除。</p>}
          <label>简短标题<input maxLength={120} required value={summary} onChange={event => setSummary(event.target.value)}/></label>
          <label>内容<textarea maxLength={2000} rows={5} required value={content} onChange={event => setContent(event.target.value)}/></label>
          <label>适用条件<textarea maxLength={300} rows={2} value={applicability} onChange={event => setApplicability(event.target.value)}/></label>
          <small className="muted">{scopeLabel(selected.record)} · {origin[selected.record.origin]}</small>
          <details><summary>来源</summary>{selected.sources.map((source, index) => <p key={index}>{source.label}</p>)}</details>
          <div className="memory-editor-actions"><button type="submit" disabled={busy}>保存</button><button type="button" disabled={busy} onClick={() => { if (window.confirm("删除这条记忆及历史版本？原对话保留。")) void run(async () => { await api!.forget(selected.record.id, selected.record.revision); setSelected(undefined); }); }}>删除</button></div>
          {selected.history.length > 0 && <details><summary>历史版本（{selected.history.length}）</summary>{selected.history.map(record => <div key={record.revision} className="memory-history"><small>{time(record.updatedAt)}</small><p>{record.content}</p>{record.applicability && <p>{record.applicability}</p>}</div>)}</details>}
        </form>}
      </div>
      {dashboard.learning.some(job => ["failed", "interrupted", "skipped"].includes(job.status)) && <details className="memory-learning"><summary>最近自动学习状态</summary>{dashboard.learning.filter(job => ["failed", "interrupted", "skipped"].includes(job.status)).slice(0, 5).map((job, i) => <p key={i}>{time(job.updatedAt)} · {job.status === "interrupted" ? "处理中断" : job.status === "skipped" ? "已跳过" : "提炼未完成"}{job.reason ? ` · ${job.reason}` : ""}</p>)}<button type="button" disabled={busy} onClick={() => void run(() => api!.retry())}>重新尝试提炼</button></details>}
    </>}
  </div>;
}
