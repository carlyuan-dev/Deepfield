import { useEffect, useRef, useState } from "react";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import type { CompanyProfileProgress, CompanyResearchBatchState } from "../contracts/index.js";

const terminal = (batch: CompanyResearchBatchState | null): boolean => batch?.status === "completed" || batch?.status === "cancelled";
const profileTerminal = (profile: CompanyProfileProgress | null): boolean => profile?.status === "completed";

export function useOperationProgress(api: DesktopApi, itemId: string, listVisible = true): { batch: CompanyResearchBatchState | null; profile: CompanyProfileProgress | null } {
  const [batch, setBatch] = useState<CompanyResearchBatchState | null>(null);
  const [profile, setProfile] = useState<CompanyProfileProgress | null>(null);
  const visible = useRef(listVisible);
  visible.current = listVisible;
  useEffect(() => {
    if (!listVisible) {
      setBatch(current => terminal(current) ? null : current);
      setProfile(current => profileTerminal(current) ? null : current);
    }
  }, [listVisible]);
  useEffect(() => {
    let alive = true; let batchEventSeen = false; let profileEventSeen = false;
    setBatch(null); setProfile(null);
    const unsubscribeBatch = api.companyResearchBatch.subscribe((state) => {
      if (!alive || state.itemId !== itemId) return;
      batchEventSeen = true;
      if (!terminal(state)) setProfile(current => profileTerminal(current) ? null : current);
      setBatch(terminal(state) && !visible.current ? null : state);
    });
    const unsubscribeProfile = api.industryResearch.subscribeCompanyProfileProgress((state) => {
      if (!alive || state.itemId !== itemId) return;
      profileEventSeen = true;
      if (state.status !== "idle") setBatch(current => terminal(current) ? null : current);
      setProfile(current => state.status === "idle"
        ? profileTerminal(current) ? current : null
        : state.status === "completed" && !visible.current ? null : state);
    });
    void api.companyResearchBatch.getState(itemId).then((state) => { if (alive && !batchEventSeen) setBatch(terminal(state) ? null : state); }).catch(() => {});
    void api.industryResearch.getCompanyProfileProgress(itemId).then((state) => {
      if (alive && !profileEventSeen && state.itemId === itemId && state.status !== "completed") setProfile(state.status === "idle" ? null : state);
    }).catch(() => {});
    return () => { alive = false; unsubscribeBatch(); unsubscribeProfile(); };
  }, [api, itemId]);
  return {
    batch: batch?.itemId === itemId && (!terminal(batch) || listVisible) ? batch : null,
    profile: profile?.itemId === itemId && (!profileTerminal(profile) || listVisible) ? profile : null,
  };
}
