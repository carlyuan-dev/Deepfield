import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompanyResearchState,
  CompanyResearchWorkerEvent,
  DesktopApi,
  ResearchRun,
  StartCompanyResearchInput,
} from "@deepfield/contracts";

const EMPTY_STATE: CompanyResearchState = { completed: [] };

export interface CompanyResearchViewModel {
  state: CompanyResearchState;
  selectedRun: ResearchRun | undefined;
  selectedRunId: string | undefined;
  elapsedLabel: string | undefined;
  loading: boolean;
  error: string | undefined;
  start(input: StartCompanyResearchInput): Promise<void>;
  cancel(): Promise<void>;
  selectRun(runId: string): void;
}

function mergeSnapshot(
  current: CompanyResearchState,
  snapshot: CompanyResearchState,
): CompanyResearchState {
  if (
    current.active !== undefined &&
    snapshot.active?.run.id === current.active.run.id &&
    current.active.draftText.length > snapshot.active.draftText.length
  ) {
    return { ...snapshot, active: current.active };
  }
  return snapshot;
}

function formatElapsed(createdAt: string, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 1000));
  if (elapsedSeconds < 60) return `已运行 ${elapsedSeconds} 秒`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `已运行 ${minutes} 分 ${seconds} 秒`;
}

export function useCompanyResearch(
  api: DesktopApi,
  itemId: string,
  companyId: string,
): CompanyResearchViewModel {
  const [state, setState] = useState<CompanyResearchState>(EMPTY_STATE);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const activeRunId = useRef<string | undefined>(undefined);

  const loadState = useCallback(async (preferNewest = false): Promise<void> => {
    const snapshot = await api.companyResearch.getState(itemId, companyId);
    activeRunId.current = snapshot.active?.run.id;
    setState((current) => mergeSnapshot(current, snapshot));
    setSelectedRunId((current) => {
      if (preferNewest) return snapshot.completed[0]?.id;
      return snapshot.completed.some((run) => run.id === current)
        ? current
        : snapshot.completed[0]?.id;
    });
  }, [api, companyId, itemId]);

  useEffect(() => {
    let alive = true;
    setState(EMPTY_STATE);
    setSelectedRunId(undefined);
    setLoading(true);
    setError(undefined);
    const unsubscribe = api.companyResearch.subscribe((event: CompanyResearchWorkerEvent) => {
      if (!alive) return;
      if (activeRunId.current !== event.runId) return;
      if (event.type === "text_delta") {
        setState((current) => current.active?.run.id === event.runId
          ? {
              ...current,
              active: {
                ...current.active,
                draftText: current.active.draftText + event.delta,
              },
            }
          : current);
        return;
      }
      if (event.type === "completed") {
        void loadState(true).catch(() => setError("加载调研报告失败，请重试"));
        return;
      }
      if (event.type === "failed") {
        setError("调研未完成，请稍后重试");
        void loadState().catch(() => {});
        return;
      }
      if (event.type === "cancelled") {
        void loadState().catch(() => setError("刷新调研状态失败，请重试"));
      }
    });
    void loadState()
      .catch(() => {
        if (alive) setError("加载调研状态失败，请重试");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      activeRunId.current = undefined;
      unsubscribe();
    };
  }, [api, companyId, itemId, loadState]);

  useEffect(() => {
    if (state.active === undefined) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [state.active?.run.id]);

  const start = useCallback(async (input: StartCompanyResearchInput): Promise<void> => {
    setError(undefined);
    const run = await api.companyResearch.start(itemId, companyId, input);
    activeRunId.current = run.id;
    setState((current) => ({ ...current, active: { run, draftText: "" } }));
    setNow(Date.now());
    await loadState();
  }, [api, companyId, itemId, loadState]);

  const cancel = useCallback(async (): Promise<void> => {
    const active = state.active;
    if (active === undefined) return;
    setError(undefined);
    try {
      await api.companyResearch.cancel(active.run.id);
      await loadState();
    } catch {
      setError("取消调研失败，请重试");
    }
  }, [api, loadState, state.active]);

  const selectedRun = useMemo(
    () => state.completed.find((run) => run.id === selectedRunId) ?? state.completed[0],
    [selectedRunId, state.completed],
  );

  return {
    state,
    selectedRun,
    selectedRunId: selectedRun?.id,
    elapsedLabel: state.active === undefined
      ? undefined
      : formatElapsed(state.active.run.createdAt, now),
    loading,
    error,
    start,
    cancel,
    selectRun: setSelectedRunId,
  };
}
