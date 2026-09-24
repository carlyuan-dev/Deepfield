import { useEffect, useRef, useState } from "react";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import { researchRetryMode, type CompanyResearchEvent, type CompanyResearchState, type ResearchRun, type StartCompanyResearchInput } from "../contracts/index.js";
import { assertResearchReady } from "./research-readiness.js";

import { researchActionError } from "./research-error-presentation.js";
import { reportRevision } from "./report-revision.js";

const EMPTY_STATE: CompanyResearchState = { runs: [], globalActiveRun: null };
export type ResearchViewError =
  | { kind: "state-load" | "detail-load" | "action" | "execution"; message: string }
  | { kind: "configuration"; message: string; settingsModule: "llm" | "search" };
interface View {
  state: CompanyResearchState;
  selectedRunId: string | undefined;
  selectedRun: ResearchRun | undefined;
  streamedRaw: { runId: string; text: string } | undefined;
  loading: boolean;
  detailLoading: boolean;
  pending: boolean;
  error: ResearchViewError | undefined;
}
const EMPTY_VIEW: View = { state: EMPTY_STATE, selectedRunId: undefined, selectedRun: undefined, streamedRaw: undefined, loading: true, detailLoading: false, pending: false, error: undefined };
const RESEARCH_FAILURE_MESSAGES: Record<string, string> = {
  research_failed: "调研未完成，请稍后重试",
  web_search_failed: "联网搜索未成功，请检查 Search 配置或稍后重试",
  tool_failed: "联网工具未能取得足够资料，请检查 Search 配置或稍后重试",
  model_failed: "模型生成调研报告失败，请检查 LLM 配置或稍后重试",
  empty_report: "模型未返回可用的调研报告，请重试",
  protocol_leak: "模型返回了工具协议内容，未保存为报告，请重试",
  language_validation_failed: "模型返回的报告语言不符合要求，请重试",
  incomplete_response: "模型响应未完整结束，请重试",
  protocol_error: "调研进程通信异常，请重试",
  storage_failed: "调研结果保存失败，请重试",
};
interface Actions {
  start(input: StartCompanyResearchInput): Promise<void>;
  cancel(): Promise<void>;
  retry(input: StartCompanyResearchInput): Promise<void>;
  retryStructuring(): Promise<void>;
  deleteSelected(): Promise<void>;
  reload(): void;
  refreshFromNavigation(): void;
  selectRun(id: string): void;
}

export function useCompanyResearch(api: DesktopApi, itemId: string, companyId: string, requestedRunId?: string, requestedRevision?: string) {
  const [view, setView] = useState(EMPTY_VIEW);
  const [now, setNow] = useState(Date.now);
  const actions = useRef<Actions | undefined>(undefined);

  useEffect(() => {
    // Async work belongs to this target/session. A separate ticket protects
    // history selection even when an earlier detail request is still pending.
    let alive = true;
    let current = { ...EMPTY_VIEW, selectedRunId: requestedRunId };
    let pinnedRunId = requestedRunId;
    let pinnedRevision = requestedRevision;
    let revision = 0;
    let detailTicket = 0;
    let refreshing: Promise<boolean> | undefined;
    const publish = (patch: Partial<View>) => {
      if (!alive) return;
      current = { ...current, ...patch };
      setView(current);
    };
    publish(EMPTY_VIEW);

    const loadDetail = async (id: string | undefined) => {
      const ticket = ++detailTicket;
      if (id === undefined) {
        publish({ selectedRun: undefined, detailLoading: false });
        return;
      }
      publish({ detailLoading: true });
      try {
        const run = await api.companyResearch.getRun(itemId, companyId, id);
        if (run && id === requestedRunId && pinnedRevision) {
          const actual = await reportRevision(run);
          if (!alive || ticket !== detailTicket) return;
          if (pinnedRevision && actual !== pinnedRevision) { publish({ selectedRun: undefined, error: { kind: "detail-load", message: "报告内容已更新，请重新打开最新报告引用。" } }); return; }
        }
        if (!alive || ticket !== detailTicket) return;
        if (!run || run.id !== id || run.itemId !== itemId || run.companyId !== companyId) {
          publish({ selectedRun: undefined, error: { kind: "detail-load", message: "加载调研报告失败，请重试" } });
        } else {
          publish({ selectedRun: run, error: current.error?.kind === "detail-load" ? undefined : current.error });
        }
      } catch {
        if (alive && ticket === detailTicket) publish({ error: { kind: "detail-load", message: "加载调研报告失败，请重试" } });
      } finally {
        if (alive && ticket === detailTicket) publish({ detailLoading: false });
      }
    };

    const refresh = (): Promise<boolean> => {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        while (alive) {
          const requestedRevision = revision;
          try {
            const snapshot = await api.companyResearch.getState(itemId, companyId);
            if (!alive) return false;
            // Deltas have no sequence/offset. Never replay onto a snapshot that
            // may include them already; re-read after an in-flight event.
            if (requestedRevision !== revision) continue;
            const previousActive = current.state.active?.run;
            const finished = previousActive && snapshot.runs.some((run) => run.id === previousActive.id);
            const selectedRunId = pinnedRunId ?? snapshot.active?.run.id
              ?? (finished ? previousActive.id : snapshot.runs.find((run) => run.id === current.selectedRunId)?.id)
              ?? snapshot.runs[0]?.id;
            // Keep the same run's saved raw report readable during stage reloads.
            const retained = current.selectedRun?.id === selectedRunId ? current.selectedRun : undefined;
            // Raw completion clears the service's draft before getRun returns.
            // Preserve the visible stream separately from the authoritative snapshot.
            const streamedRaw = previousActive?.id === selectedRunId && previousActive?.status === "researching"
              ? { runId: previousActive.id, text: current.state.active!.draftText }
              : current.streamedRaw?.runId === selectedRunId ? current.streamedRaw : undefined;
            publish({
              state: snapshot, selectedRunId, selectedRun: retained, streamedRaw, loading: false,
              error: current.error?.kind === "state-load" ? undefined : current.error,
            });
            if (snapshot.active?.run.status === "researching" && snapshot.active.run.id === selectedRunId) {
              ++detailTicket;
              publish({ selectedRun: undefined, detailLoading: false });
            } else {
              void loadDetail(selectedRunId);
            }
            return true;
          } catch {
            if (!alive) return false;
            if (requestedRevision !== revision) continue;
            publish({ loading: false, error: { kind: "state-load", message: "加载调研状态失败，请重试" } });
            return false;
          }
        }
        return false;
      })().finally(() => { refreshing = undefined; });
      return refreshing;
    };

    const unsubscribe = api.companyResearch.subscribe((event: CompanyResearchEvent) => {
      if (!alive) return;
      if (event.type === "state_changed") {
        if (event.itemId !== itemId || event.companyId !== companyId) return;
        ++revision;
        ++detailTicket;
        if (event.outcome && event.outcome !== "cancelled") publish({ error: { kind: "execution", message: RESEARCH_FAILURE_MESSAGES[event.outcome] ?? "调研未完成，请稍后重试" } });
        else if (current.error?.kind === "execution") publish({ error: undefined });
        void refresh();
      } else if (event.type === "tool_activity" && event.stage === "raw") {
        const active = current.state.active;
        if (active?.run.id === event.runId && active.run.status === "researching") {
          publish({ state: { ...current.state, active: { ...active, latestActivity: {
            callKey: event.callKey, name: event.name, status: event.status,
            ...(event.summary === undefined ? {} : { summary: event.summary }),
            ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          } } } });
        }
        if (active?.run.id === event.runId && refreshing) { ++revision; void refresh(); }
      } else if (event.type === "text_delta" && event.stage === "raw") {
        const active = current.state.active;
        if (active?.run.id === event.runId && active.run.status === "researching") {
          publish({ state: { ...current.state, active: { ...active, draftText: active.draftText + event.delta } } });
        }
        if (active?.run.id === event.runId && refreshing) {
          ++revision;
          void refresh();
        }
      }
    });
    actions.current = {
      async start(input) {
        if (!alive || current.pending) return;
        publish({ pending: true, error: undefined });
        try {
          await assertResearchReady(api, { search: true });
          if (!alive) return;
          await api.companyResearch.start(itemId, companyId, input);
          pinnedRunId = undefined;
          if (!alive) return;
          ++detailTicket;
          publish({ selectedRunId: undefined, selectedRun: undefined, streamedRaw: undefined });
          ++revision;
          await refresh();
        } catch (error) {
          if (alive) {
            const presentation = researchActionError(error, "start");
            publish({ error: presentation.settingsModule
              ? { kind: "configuration", message: presentation.message, settingsModule: presentation.settingsModule }
              : { kind: "action", message: presentation.message } });
          }
          throw error;
        } finally { publish({ pending: false }); }
      },
      async cancel() {
        const id = current.state.active?.run.id;
        if (!alive || !id || current.pending) return;
        publish({ pending: true, error: undefined });
        try {
          await api.companyResearch.cancel(id);
          if (!alive) return;
          ++revision;
          await refresh();
        } catch {
          publish({ error: { kind: "action", message: "取消调研失败，请重试" } });
        } finally { publish({ pending: false }); }
      },
      async retry(input) {
        const run = current.state.runs.find((entry) => entry.id === current.selectedRunId);
        if (!alive || current.pending || !run || researchRetryMode(run, input) === "unavailable") return;
        publish({ pending: true, error: undefined });
        try {
          await assertResearchReady(api, { search: researchRetryMode(run, input) === "raw" });
          if (!alive) return;
          await api.companyResearch.retryFailed(itemId, companyId, run.id, input);
          if (!alive) return;
          pinnedRevision = undefined;
          pinnedRunId = run.id;
          ++detailTicket;
          publish({ selectedRunId: run.id });
          ++revision;
          await refresh();
        } catch (error) {
          const presentation = researchActionError(error, "retry");
          publish({ error: presentation.settingsModule
            ? { kind: "configuration", message: presentation.message, settingsModule: presentation.settingsModule }
            : { kind: "action", message: presentation.message } });
          throw error;
        }
        finally { publish({ pending: false }); }
      },
      async retryStructuring() {
        const run = current.state.runs.find((entry) => entry.id === current.selectedRunId);
        if (!alive || current.pending || run?.status !== "structure_failed") return;
        publish({ pending: true, error: undefined });
        try {
          await assertResearchReady(api, { search: false });
          if (!alive) return;
          await api.companyResearch.retryStructuring(itemId, companyId, run.id);
          if (!alive) return;
          pinnedRevision = undefined;
          pinnedRunId = run.id;
          ++detailTicket;
          publish({ selectedRunId: run.id });
          ++revision;
          await refresh();
        } catch (error) {
          const presentation = researchActionError(error, "retry");
          publish({ error: presentation.settingsModule
            ? { kind: "configuration", message: presentation.message, settingsModule: presentation.settingsModule }
            : { kind: "action", message: presentation.message } });
          throw error;
        } finally { publish({ pending: false }); }
      },
      async deleteSelected() {
        const deletedId = current.selectedRunId;
        const deletedIndex = current.state.runs.findIndex((run) => run.id === deletedId);
        if (!alive || current.pending || deletedId === undefined || deletedIndex < 0) return;
        publish({ pending: true, error: undefined });
        try {
          await api.companyResearch.deleteRun(itemId, companyId, deletedId);
          if (!alive) return;
          pinnedRunId = undefined;
          ++revision;
          const refreshed = await refresh();
          if (!alive) return;
          if (!refreshed) {
            ++detailTicket;
            publish({
              state: { ...current.state, runs: current.state.runs.filter((run) => run.id !== deletedId) },
              selectedRunId: undefined,
              selectedRun: undefined,
              streamedRaw: undefined,
              detailLoading: false,
            });
            return;
          }
          const remaining = current.state.runs;
          const next = remaining[deletedIndex] ?? remaining[deletedIndex - 1] ?? remaining[0];
          pinnedRunId = next?.id;
          const retained = current.selectedRun?.id === next?.id ? current.selectedRun : undefined;
          ++detailTicket;
          publish({ selectedRunId: next?.id, selectedRun: retained, streamedRaw: undefined, error: undefined });
          if (!retained) await loadDetail(next?.id);
        } catch {
          publish({ error: { kind: "action", message: "删除调研报告失败，请重试" } });
          throw new Error("删除调研报告失败，请重试");
        } finally { publish({ pending: false }); }
      },
      reload() {
        if (current.error?.kind === "detail-load") {
          publish({ error: undefined });
          void loadDetail(current.selectedRunId);
        } else if (current.error?.kind === "state-load") {
          publish({ error: undefined });
          ++revision;
          void refresh();
        }
      },
      refreshFromNavigation() {
        pinnedRunId = undefined;
        pinnedRevision = undefined;
        ++revision;
        ++detailTicket;
        void refresh();
      },
      selectRun(id) {
        if (current.state.active || !current.state.runs.some((run) => run.id === id)) return;
        pinnedRunId = id;
        publish({
          selectedRunId: id, selectedRun: undefined, streamedRaw: undefined,
          error: current.error?.kind === "detail-load" || current.error?.kind === "execution" ? undefined : current.error,
        });
        void loadDetail(id);
      },
    };
    void refresh();
    return () => { alive = false; ++detailTicket; unsubscribe(); actions.current = undefined; };
  }, [api, itemId, companyId, requestedRunId, requestedRevision]);

  const active = view.state.active;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active?.run.id]);
  const seconds = active ? Math.max(0, Math.floor((now - Date.parse(active.run.createdAt)) / 1000)) : 0;
  return {
    ...view,
    rawDraftText: view.streamedRaw?.runId === view.selectedRunId ? view.streamedRaw?.text ?? "" : "",
    elapsedLabel: seconds < 60 ? `已运行 ${seconds} 秒` : `已运行 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
    selectedFailureMessage: (() => {
      const selected = view.state.runs.find((run) => run.id === view.selectedRunId);
      return selected?.status === "research_failed"
        ? RESEARCH_FAILURE_MESSAGES[selected.lastFailureCode ?? "research_failed"] ?? RESEARCH_FAILURE_MESSAGES.research_failed
        : undefined;
    })(),
    start: (input: StartCompanyResearchInput) => actions.current!.start(input),
    cancel: () => actions.current!.cancel(),
    retry: (input: StartCompanyResearchInput) => actions.current!.retry(input),
    retryStructuring: () => actions.current!.retryStructuring(),
    deleteSelected: () => actions.current!.deleteSelected(),
    reload: () => actions.current!.reload(),
    refreshFromNavigation: () => actions.current!.refreshFromNavigation(),
    selectRun: (id: string) => actions.current!.selectRun(id),
  };
}
