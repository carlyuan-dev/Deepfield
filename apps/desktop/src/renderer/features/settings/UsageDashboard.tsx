import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { UsageDashboard, UsageDashboardQuery, UsageModelIdentity, UsageProviderBreakdown, UsageRange, UsageServiceKind, UsageSummary } from "@deepfield/base/usage";
import type { DesktopApi } from "@deepfield/contracts";

import { UsageCharts } from "./UsageCharts.js";
import "./usage-dashboard.css";

const POLL_INTERVAL_MS = 30_000;
const PROVIDER_NAMES: Record<string, string> = {
  deepseek: "DeepSeek",
  qwen: "Qwen",
  zhipu: "智谱搜索",
  tavily: "Tavily",
  doubao: "豆包搜索",
};

type LoadState = "loading" | "ready" | "error";

const numberFormatter = new Intl.NumberFormat("zh-CN");
const formatMetric = (value: number | null): string => value === null ? "未知" : numberFormatter.format(value);
const providerName = (providerId: string): string => PROVIDER_NAMES[providerId] ?? providerId;
const outcomeText = (value: UsageSummary): string => `成功 ${value.succeeded} · 失败 ${value.failed} · 取消 ${value.cancelled} · 运行中 ${value.running} · 中断 ${value.interrupted}`;
const modelValue = (model: UsageModelIdentity): string => `${model.providerId}\u0000${model.modelId}`;

function customRangeError(startDate: string, endDate: string): string | undefined {
  if (!startDate || !endDate) return "请选择开始和结束日期。";
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "请输入有效日期。";
  if (start > end) return "开始日期不能晚于结束日期。";
  if (Math.floor((end - start) / 86_400_000) + 1 > 366) return "自定义范围最多 366 天。";
  return undefined;
}

function percent(value: number, maximum: number): CSSProperties {
  return { width: `${value > 0 && maximum > 0 ? Math.max(2, value / maximum * 100) : 0}%` };
}

function HeadlineMetric({ label, value }: { label: string; value: string }) {
  return <div className="usage-headline-metric" aria-label={label}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>;
}

function CompletenessNotices({ value, onAcknowledge, disabled }: { value: UsageDashboard; onAcknowledge: () => void; disabled: boolean }) {
  const { nonDismissibleCount: unknownUsageRequests, partialCount, incompleteAttemptCount } = value.unknownUsage;
  if (unknownUsageRequests === 0 && partialCount === 0 && incompleteAttemptCount === 0) return null;
  return <div className="usage-notices" role="status" aria-label="统计完整性">
    {unknownUsageRequests > 0 && <span>{unknownUsageRequests} 次请求用量未知，记录不可删除</span>}
    {partialCount > 0 && <span>{partialCount} 次请求仅部分上报</span>}
    {incompleteAttemptCount > 0 && <span>{incompleteAttemptCount} 次请求的实际尝试数可能不完整</span>}
    <button type="button" aria-label="确认统计完整性提示" disabled={disabled} onClick={onAcknowledge}>×</button>
  </div>;
}

function UnknownUsageNotice({ value, deleting, error, onDelete }: { value: UsageDashboard; deleting: boolean; error: boolean; onDelete: () => void }) {
  const notice = value.unknownUsage;
  if (notice.dismissibleCount === 0) return null;
  const text = notice.networkFailureCount === notice.dismissibleCount
    ? `${notice.networkFailureCount} 次网络失败请求未返回 Token 用量`
    : `${notice.dismissibleCount} 次异常请求未返回 Token 用量`;
  const label = `永久删除这 ${notice.dismissibleCount} 条失败记录`;
  return <div className="usage-notices" role="status" aria-label="未知用量失败记录">
    <span>{text}</span>
    <button type="button" aria-label={label} title={`${label}；此操作不可撤销`} disabled={deleting} onClick={onDelete}>×</button>
    {error && <span role="alert">删除失败，记录仍保留，请重试。</span>}
  </div>;
}

function ProviderRow({ provider, serviceKind, maximum }: { provider: UsageProviderBreakdown; serviceKind: UsageServiceKind; maximum: number }) {
  const contribution = serviceKind === "llm" ? provider.totalTokens ?? 0 : provider.requests;
  return <li className="usage-provider-row">
    <div className="usage-provider-heading"><strong>{providerName(provider.providerId)}</strong><span>{provider.requests} 次请求</span></div>
    <div className="usage-contribution-track" aria-hidden="true"><span className={serviceKind === "search" ? "usage-search-fill" : ""} data-series={serviceKind === "search" ? "search" : undefined} style={percent(contribution, maximum)} /></div>
    <div className="usage-provider-meta">
      <span>{serviceKind === "llm" ? `已记录 Token ${formatMetric(provider.totalTokens)}` : `已记录结果 ${formatMetric(provider.resultCount)}`}</span>
      <span>{outcomeText(provider)}</span>
    </div>
    {serviceKind === "llm" && provider.models.length > 0 && <ul className="usage-model-list" aria-label="模型贡献">
      {provider.models.map((model) => <li key={model.modelId}>
        <div><strong>{model.modelId}</strong><span>{model.requests} 次请求</span></div>
        <span>已记录 Token {formatMetric(model.totalTokens)}</span>
      </li>)}
    </ul>}
  </li>;
}

function ProviderBreakdown({ value, serviceKind }: { value: UsageDashboard; serviceKind: UsageServiceKind }) {
  const maximum = Math.max(1, ...value.providers.map((provider) => serviceKind === "llm" ? provider.totalTokens ?? 0 : provider.requests));
  return <section className="usage-panel" aria-labelledby="usage-provider-title">
    <div className="usage-panel-heading"><div><h3 id="usage-provider-title">Provider 贡献</h3><p>{serviceKind === "llm" ? "全部模型的全局汇总，按 Provider 展开到模型" : "所有 Search 请求的全局 Provider 汇总"}</p></div></div>
    <ul className="usage-provider-list" aria-label="Provider 贡献">
      {value.providers.map((provider) => <ProviderRow key={provider.providerId} provider={provider} serviceKind={serviceKind} maximum={maximum} />)}
    </ul>
  </section>;
}

function HealthNotice({ value, repairing, repairError, onRepair, onAcknowledge }: { value: UsageDashboard; repairing: boolean; repairError: boolean; onRepair: () => void; onAcknowledge: () => void }) {
  const { health } = value;
  const [collapsed, setCollapsed] = useState(false);
  const incident = `${health.currentFailure}:${health.lastErrorCode}:${health.recoverableRecords}`;
  useEffect(() => { setCollapsed(false); }, [incident]);
  const failureText = health.lastErrorCode === "usage_storage_unavailable" || health.lastErrorCode === "usage_unavailable" || health.lastErrorCode === "health_write_failed"
    ? "本地用量存储暂时不可用" : "部分用量记录尚未写入";
  return <div className="usage-health-stack">
    {health.currentFailure && collapsed && <div className="usage-health-warning" role="status"><span>{failureText}</span><button type="button" disabled={repairing} onClick={onRepair}>{repairing ? "正在修复…" : "修复"}</button>{repairError && <span role="alert">修复未完成，请稍后重试。</span>}</div>}
    {health.currentFailure && !collapsed && <div className="usage-health-warning" role="alert">
      <strong>用量记录当前不可用</strong>
      <span>{failureText}</span>
      <span>待重试 {health.recoverableRecords} 条</span>
      <button type="button" disabled={repairing} onClick={onRepair}>{repairing ? "正在修复…" : "修复"}</button>
      <button type="button" aria-label="收起当前用量故障" onClick={() => setCollapsed(true)}>×</button>
      {repairError && <span>修复未完成，请稍后重试。</span>}
    </div>}
    {!health.currentFailure && value.historicalNotice.fingerprint && <div className="usage-notices" role="status" aria-label="历史记录缺口">
      <span>历史记录可能不完整：无法恢复 {value.historicalNotice.droppedRecords} · 中断 {value.historicalNotice.interruptedRequests}</span>
      <button type="button" aria-label="确认历史记录缺口" disabled={repairing} onClick={onAcknowledge}>×</button>
    </div>}
  </div>;
}

export function UsageDashboardView({ api }: { api: DesktopApi }) {
  const [serviceKind, setServiceKind] = useState<UsageServiceKind>("llm");
  const [range, setRange] = useState<UsageRange>("month");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [data, setData] = useState<UsageDashboard>();
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedModel, setSelectedModelState] = useState<UsageModelIdentity | null>(null);
  const [deletingUnknown, setDeletingUnknown] = useState(false);
  const [deleteUnknownError, setDeleteUnknownError] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState(false);
  const [showPending, setShowPending] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgeError, setAcknowledgeError] = useState(false);
  const selectedModelRef = useRef<UsageModelIdentity | null>(null);
  const requestSequence = useRef(0);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const rangeError = range === "custom" ? customRangeError(startDate, endDate) : undefined;

  const createQuery = useCallback((model: UsageModelIdentity | null): UsageDashboardQuery | null => {
    if (range === "custom") {
      if (rangeError) return null;
      return serviceKind === "llm"
        ? { serviceKind, range, timeZone, startDate, endDate, ...(model ? { model } : {}) }
        : { serviceKind, range, timeZone, startDate, endDate };
    }
    return serviceKind === "llm"
      ? { serviceKind, range, timeZone, ...(model ? { model } : {}) }
      : { serviceKind, range, timeZone };
  }, [endDate, range, rangeError, serviceKind, startDate, timeZone]);

  const load = useCallback(async (showLoading: boolean, model = selectedModelRef.current) => {
    const query = createQuery(model);
    if (!query) return;
    const sequence = ++requestSequence.current;
    if (showLoading) setLoadState("loading");
    try {
      const next = await api.usage.getDashboard(query);
      if (sequence !== requestSequence.current) return;
      if (serviceKind === "llm" && next.trend.selectedModel) {
        selectedModelRef.current = next.trend.selectedModel;
        setSelectedModelState(next.trend.selectedModel);
      }
      setData(next);
      setLoadState("ready");
    } catch {
      if (sequence !== requestSequence.current) return;
      setLoadState("error");
    }
  }, [api, createQuery, serviceKind]);
  const latestLoad = useRef(load);
  latestLoad.current = load;

  useEffect(() => {
    if (!createQuery(selectedModelRef.current)) {
      requestSequence.current += 1;
      setData(undefined);
      setLoadState("ready");
      return;
    }
    void load(true);
    return () => { requestSequence.current += 1; };
  }, [createQuery, load]);

  const active = data !== undefined && (data.inFlightRequests > 0 || data.summary.running > 0 || data.health.pendingRecords > 0 || data.health.currentFailure);
  useEffect(() => {
    if (!active) return;
    const refreshWhenVisible = () => { if (document.visibilityState === "visible") void load(false); };
    const timer = window.setInterval(refreshWhenVisible, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [active, load]);

  useEffect(() => {
    if (!data?.health.pendingRecords) { setShowPending(false); return; }
    const timer = window.setTimeout(() => setShowPending(true), 3000);
    return () => window.clearTimeout(timer);
  }, [data?.health.pendingRecords]);

  const empty = data?.summary.requests === 0 && data.providers.length === 0;
  const deleteUnknown = useCallback(async () => {
    if (!data || deletingUnknown || data.unknownUsage.snapshot.length === 0) return;
    const snapshot = data.unknownUsage.snapshot.map((ref) => ({ ...ref }));
    setDeletingUnknown(true); setDeleteUnknownError(false);
    try { await api.usage.deleteUnknownFailures(snapshot); await latestLoad.current(false); }
    catch { setDeleteUnknownError(true); }
    finally { setDeletingUnknown(false); }
  }, [api, data, deletingUnknown]);
  const repair = useCallback(async () => {
    if (repairing) return;
    setRepairing(true); setRepairError(false);
    try { const result = await api.usage.repair(); if (!result.repaired) setRepairError(true); await latestLoad.current(false); }
    catch { setRepairError(true); }
    finally { setRepairing(false); }
  }, [api, repairing]);
  const acknowledgeUnknown = useCallback(async () => {
    if (!data || acknowledging || data.unknownUsage.acknowledgeSnapshot.length === 0) return;
    setAcknowledging(true); setAcknowledgeError(false);
    try { await api.usage.acknowledgeUnknownUsage(data.unknownUsage.acknowledgeSnapshot); await latestLoad.current(false); }
    catch { setAcknowledgeError(true); }
    finally { setAcknowledging(false); }
  }, [acknowledging, api, data]);
  const acknowledgeHistory = useCallback(async () => {
    const fingerprint = data?.historicalNotice.fingerprint;
    if (!fingerprint || acknowledging) return;
    setAcknowledging(true); setAcknowledgeError(false);
    try { await api.usage.acknowledgeHistoricalIssues(fingerprint); await latestLoad.current(false); }
    catch { setAcknowledgeError(true); }
    finally { setAcknowledging(false); }
  }, [acknowledging, api, data]);
  return <div className="usage-dashboard">
    <header className="settings-header usage-header"><div><h2>用量信息</h2><p>查看本应用记录到的模型与搜索调用。</p></div></header>
    <div className="usage-filters">
      <fieldset><legend>资源</legend><button type="button" aria-pressed={serviceKind === "llm"} onClick={() => setServiceKind("llm")}>LLM</button><button type="button" aria-pressed={serviceKind === "search"} onClick={() => setServiceKind("search")}>Search</button></fieldset>
      <fieldset><legend>统计周期</legend><button type="button" aria-pressed={range === "today"} onClick={() => setRange("today")}>今天</button><button type="button" aria-pressed={range === "7d"} onClick={() => setRange("7d")}>近7天</button><button type="button" aria-pressed={range === "30d"} onClick={() => setRange("30d")}>近30天</button><button type="button" aria-pressed={range === "month"} onClick={() => setRange("month")}>本月</button><button type="button" aria-pressed={range === "custom"} onClick={() => setRange("custom")}>自定义</button></fieldset>
    </div>
    {range === "custom" && <div className="usage-custom-range">
      <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
      <label>结束日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
      {rangeError && <p className={startDate && endDate ? "usage-range-error" : "usage-range-hint"} role={startDate && endDate ? "alert" : "status"}>{rangeError}</p>}
    </div>}

    {loadState === "loading" && <div className="usage-state" role="status">正在加载用量…</div>}
    {loadState === "error" && <div className="usage-state usage-error" role="alert"><span>无法读取用量，请重试。</span><button type="button" onClick={() => void load(true)}>重试</button></div>}
    {loadState === "ready" && data && <>
      <section className="usage-headline" aria-label="用量概览">
        <p className="usage-scope-note">{serviceKind === "llm" ? "全部模型的全局用量" : "所有 Search Provider 的全局用量"}</p>
        {serviceKind === "llm" ? <>
          <HeadlineMetric label="已记录输入 Token" value={formatMetric(data.summary.inputTokens)} />
          <HeadlineMetric label="已记录输出 Token" value={formatMetric(data.summary.outputTokens)} />
          <HeadlineMetric label="已记录总 Token" value={formatMetric(data.summary.totalTokens)} />
          <HeadlineMetric label="LLM 请求次数" value={`${data.summary.requests} 次`} />
        </> : <>
          <HeadlineMetric label="Search 请求次数" value={`${data.summary.requests} 次`} />
          <HeadlineMetric label="已记录结果数" value={formatMetric(data.summary.resultCount)} />
          <HeadlineMetric label="成功请求" value={`${data.summary.succeeded} 次`} />
          <HeadlineMetric label="失败请求" value={`${data.summary.failed} 次`} />
        </>}
      </section>
      <CompletenessNotices value={data} disabled={acknowledging} onAcknowledge={() => void acknowledgeUnknown()} />
      <UnknownUsageNotice value={data} deleting={deletingUnknown} error={deleteUnknownError} onDelete={() => void deleteUnknown()} />
      {showPending && !data.health.currentFailure && <p className="usage-range-hint" role="status">正在同步 {data.health.pendingRecords} 条用量记录…</p>}
      <HealthNotice value={data} repairing={repairing || acknowledging} repairError={repairError} onRepair={() => void repair()} onAcknowledge={() => void acknowledgeHistory()} />
      {acknowledgeError && <p className="usage-range-error" role="alert">确认失败，请重试。</p>}
      {empty && <div className="usage-state usage-empty">此范围内暂无 {serviceKind === "llm" ? "LLM" : "Search"} 用量记录。</div>}
      {serviceKind === "llm" && <div className="usage-chart-model-controls">
        <label className="usage-model-filter">模型<select aria-label="模型" value={selectedModel ? modelValue(selectedModel) : ""} disabled={data.trend.models.length === 0} onChange={(event) => {
          const model = data.trend.models.find((candidate) => modelValue(candidate) === event.target.value);
          if (!model) return;
          selectedModelRef.current = model;
          setSelectedModelState(model);
          void load(true, model);
        }}>{data.trend.models.length ? data.trend.models.map((model) => <option key={modelValue(model)} value={modelValue(model)}>{providerName(model.providerId)} / {model.modelId}</option>) : <option value="">暂无模型</option>}</select></label>
        <p className="usage-selected-model">{data.trend.selectedModel ? `图表模型：${providerName(data.trend.selectedModel.providerId)} / ${data.trend.selectedModel.modelId}` : "图表模型：暂无模型"}</p>
      </div>}
      <UsageCharts trend={data.trend} serviceKind={serviceKind} timeZone={data.timeZone} />
      {data.providers.length > 0 && <ProviderBreakdown value={data} serviceKind={serviceKind} />}
    </>}
    <p className="usage-disclaimer">仅统计本应用可观测用量，不代表服务商账单或剩余额度。</p>
  </div>;
}
