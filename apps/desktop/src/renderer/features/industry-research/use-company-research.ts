import { useEffect, useRef, useState } from "react";
import type { CompanyResearchEvent, CompanyResearchState, DesktopApi, ResearchRun, StartCompanyResearchInput } from "@deepfield/contracts";

const EMPTY_STATE: CompanyResearchState = { runs: [], globalActiveRun: null };
interface View {
  state: CompanyResearchState;
  selectedRunId: string | undefined;
  selectedRun: ResearchRun | undefined;
  streamedRaw: { runId: string; text: string } | undefined;
  loading: boolean;
  detailLoading: boolean;
  pending: boolean;
  error: string | undefined;
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
  retry(): Promise<void>;
  reload(): void;
  selectRun(id: string): void;
}

export function useCompanyResearch(api: DesktopApi, itemId: string, companyId: string) {
  const [view, setView] = useState(EMPTY_VIEW);
  const [now, setNow] = useState(Date.now);
  const actions = useRef<Actions | undefined>(undefined);

  useEffect(() => {
    // Async work belongs to this target/session. A separate ticket protects
    // history selection even when an earlier detail request is still pending.
    let alive = true;
    let current = EMPTY_VIEW;
    let revision = 0;
    let detailTicket = 0;
    let refreshing: Promise<void> | undefined;
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
        if (!alive || ticket !== detailTicket) return;
        if (!run || run.id !== id || run.itemId !== itemId || run.companyId !== companyId) {
          publish({ selectedRun: undefined, error: "加载调研报告失败，请重试" });
        } else {
          publish({ selectedRun: run });
        }
      } catch {
        if (alive && ticket === detailTicket) publish({ error: "加载调研报告失败，请重试" });
      } finally {
        if (alive && ticket === detailTicket) publish({ detailLoading: false });
      }
    };

    const refresh = (): Promise<void> => {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        while (alive) {
          const requestedRevision = revision;
          try {
            const snapshot = await api.companyResearch.getState(itemId, companyId);
            if (!alive) return;
            // Deltas have no sequence/offset. Never replay onto a snapshot that
            // may include them already; re-read after an in-flight event.
            if (requestedRevision !== revision) continue;
            const previousActive = current.state.active?.run;
            const finished = previousActive && snapshot.runs.some((run) => run.id === previousActive.id);
            const selectedRunId = snapshot.active?.run.id
              ?? (finished ? previousActive.id : snapshot.runs.find((run) => run.id === current.selectedRunId)?.id)
              ?? snapshot.runs[0]?.id;
            // Keep the same run's saved raw report readable during stage reloads.
            const retained = current.selectedRun?.id === selectedRunId ? current.selectedRun : undefined;
            // Raw completion clears the service's draft before getRun returns.
            // Preserve the visible stream separately from the authoritative snapshot.
            const streamedRaw = previousActive?.id === selectedRunId && previousActive?.status === "researching"
              ? { runId: previousActive.id, text: current.state.active!.draftText }
              : current.streamedRaw?.runId === selectedRunId ? current.streamedRaw : undefined;
            publish({ state: snapshot, selectedRunId, selectedRun: retained, streamedRaw, loading: false });
            if (snapshot.active?.run.status === "researching") {
              ++detailTicket;
              publish({ selectedRun: undefined, detailLoading: false });
            } else {
              void loadDetail(selectedRunId);
            }
            return;
          } catch {
            if (!alive) return;
            if (requestedRevision !== revision) continue;
            publish({ loading: false, error: "加载调研状态失败，请重试" });
            return;
          }
        }
      })().finally(() => { refreshing = undefined; });
      return refreshing;
    };

    const unsubscribe = api.companyResearch.subscribe((event: CompanyResearchEvent) => {
      if (!alive) return;
      if (event.type === "state_changed") {
        ++revision;
        // Occupancy is global, including events for other targets.
        if (event.itemId === itemId && event.companyId === companyId) {
          ++detailTicket;
          if (event.outcome && event.outcome !== "cancelled") publish({ error: RESEARCH_FAILURE_MESSAGES[event.outcome] ?? RESEARCH_FAILURE_MESSAGES.research_failed });
        }
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
        if (refreshing || !active) { ++revision; void refresh(); }
      } else if (event.type === "text_delta" && event.stage === "raw") {
        const active = current.state.active;
        if (active?.run.id === event.runId && active.run.status === "researching") {
          publish({ state: { ...current.state, active: { ...active, draftText: active.draftText + event.delta } } });
        }
        if (refreshing || !active) {
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
          const started = await api.companyResearch.start(itemId, companyId, input);
          if (!alive) return;
          // A fast run can finish before any active snapshot is observed.
          // Use only its identity; its returned stage may already be stale.
          if (started.itemId === itemId && started.companyId === companyId && current.selectedRunId !== started.id) {
            ++detailTicket;
            publish({ selectedRunId: started.id, selectedRun: undefined, streamedRaw: undefined });
          }
          ++revision;
          await refresh();
        } catch {
          if (alive) publish({ error: "无法开始调研，请稍后重试" });
          throw new Error("无法开始调研，请稍后重试");
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
          publish({ error: "取消调研失败，请重试" });
        } finally { publish({ pending: false }); }
      },
      async retry() {
        const run = current.state.runs.find((entry) => entry.id === current.selectedRunId);
        if (!alive || current.pending || current.state.globalActiveRun || run?.status !== "structure_failed") return;
        publish({ pending: true, error: undefined });
        try {
          await api.companyResearch.retryStructuring(itemId, companyId, run.id);
          if (!alive) return;
          ++revision;
          await refresh();
        } catch { publish({ error: "无法重新整理，请稍后重试" }); }
        finally { publish({ pending: false }); }
      },
      reload() { publish({ error: undefined }); ++revision; void refresh(); },
      selectRun(id) {
        if (current.state.active || !current.state.runs.some((run) => run.id === id)) return;
        publish({ selectedRunId: id, selectedRun: undefined, streamedRaw: undefined, error: undefined });
        void loadDetail(id);
      },
    };
    void refresh();
    return () => { alive = false; ++detailTicket; unsubscribe(); actions.current = undefined; };
  }, [api, itemId, companyId]);

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
    start: (input: StartCompanyResearchInput) => actions.current!.start(input),
    cancel: () => actions.current!.cancel(),
    retry: () => actions.current!.retry(),
    reload: () => actions.current!.reload(),
    selectRun: (id: string) => actions.current!.selectRun(id),
  };
}
