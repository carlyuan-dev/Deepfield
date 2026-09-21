import { useCallback, useEffect, useRef, useState } from "react";
import { RECOGNITION_TEXT_TOO_LONG_MESSAGE, RecognitionTextTooLongError, chunkRecognitionText } from "@deepfield/contracts";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import { type CompanyDraft, type ItemCompanyView } from "../contracts/index.js";
import { Modal } from "../../../apps/desktop/src/renderer/components/Modal.js";

export interface ImportCompaniesModalProps {
  api: DesktopApi;
  itemId: string;
  active?: boolean;
  onClose(): void;
  onCompaniesAdded(companies: ItemCompanyView[]): void;
}

interface RecognitionRun { chunks: string[]; nextIndex: number; }

function normalizedCompanyName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function mergeDrafts(current: CompanyDraft[], incoming: CompanyDraft[]): CompanyDraft[] {
  const seen = new Set(current.map((draft) => normalizedCompanyName(draft.name)));
  const merged = [...current];
  for (const draft of incoming) {
    const normalized = normalizedCompanyName(draft.name);
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      merged.push(draft);
    }
  }
  return merged;
}

export function ImportCompaniesModal({ api, itemId, active = true, onClose, onCompaniesAdded }: ImportCompaniesModalProps) {
  const [sourceText, setSourceText] = useState("");
  const [drafts, setDrafts] = useState<CompanyDraft[]>();
  const [run, setRun] = useState<RecognitionRun>();
  const [progress, setProgress] = useState<{ current: number; total: number }>();
  const [recognizing, setRecognizing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const runToken = useRef(0);

  useEffect(() => () => { runToken.current += 1; }, []);

  const close = useCallback((): void => {
    runToken.current += 1;
    onClose();
  }, [onClose]);

  const changeSource = (value: string): void => {
    runToken.current += 1;
    setSourceText(value);
    setDrafts(undefined);
    setRun(undefined);
    setProgress(undefined);
    setRecognizing(false);
    setError(undefined);
  };

  const recognize = async (): Promise<void> => {
    if (recognizing || sourceText.trim().length === 0) return;
    let activeRun = run;
    let collected = drafts ?? [];
    if (activeRun === undefined || activeRun.nextIndex >= activeRun.chunks.length) {
      try {
        activeRun = { chunks: chunkRecognitionText(sourceText), nextIndex: 0 };
      } catch (caught) {
        setError(caught instanceof RecognitionTextTooLongError ? RECOGNITION_TEXT_TOO_LONG_MESSAGE : "识别失败，请重试");
        return;
      }
      collected = [];
      setDrafts([]);
      setRun(activeRun);
    }
    if (activeRun.chunks.length === 0) return;

    const token = ++runToken.current;
    setRecognizing(true);
    setError(undefined);
    for (let index = activeRun.nextIndex; index < activeRun.chunks.length; index += 1) {
      if (runToken.current !== token) return;
      setProgress({ current: index + 1, total: activeRun.chunks.length });
      try {
        const recognized = await api.industryResearch.recognizeCompanies(itemId, activeRun.chunks[index]!);
        if (runToken.current !== token) return;
        collected = mergeDrafts(collected, recognized);
        setDrafts(collected);
        setRun({ chunks: activeRun.chunks, nextIndex: index + 1 });
      } catch {
        if (runToken.current !== token) return;
        setRun({ chunks: activeRun.chunks, nextIndex: index });
        setError("识别失败，请重试");
        setRecognizing(false);
        return;
      }
    }
    if (runToken.current === token) {
      setRecognizing(false);
      setProgress(undefined);
      if (collected.length === 0) setError("没有识别到公司，请调整文本后重试。");
    }
  };

  const updateDraft = (index: number, value: string): void => {
    setDrafts((current) => current?.map((draft, draftIndex) => draftIndex === index ? { name: value } : draft));
  };

  const confirm = async (): Promise<void> => {
    if (
      submitting ||
      drafts === undefined ||
      drafts.length === 0 ||
      (run !== undefined && run.nextIndex < run.chunks.length)
    ) return;
    const cleaned = drafts.map((draft) => ({ name: draft.name.trim() }));
    if (cleaned.some((draft) => draft.name.length === 0)) {
      setError("请填写公司名称");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      onCompaniesAdded(await api.industryResearch.addCompanies(itemId, cleaned));
      close();
    } catch {
      setError("导入失败，请重试");
      setSubmitting(false);
    }
  };

  const retryIndex = run !== undefined && run.nextIndex < run.chunks.length ? run.nextIndex : undefined;
  const recognitionIncomplete = retryIndex !== undefined;
  const recognizeLabel = recognizing && progress !== undefined
    ? "正在识别…"
    : retryIndex !== undefined
      ? "重试识别"
      : drafts === undefined ? "识别公司" : "重新识别";

  return (
    <Modal title="一键导入公司" active={active} onClose={close}>
      <div className="modal-body import-companies">
        {error !== undefined && <p className="error" role="alert">{error}</p>}
        <label>公司文本<textarea value={sourceText} disabled={recognizing} onChange={(event) => changeSource(event.target.value)} placeholder="粘贴公司名称或含公司信息的文本" rows={5} /></label>
        <button className="recognize-button" type="button" disabled={recognizing || submitting || sourceText.trim().length === 0} onClick={() => void recognize()}>{recognizeLabel}</button>
        {recognitionIncomplete && !recognizing && drafts !== undefined && drafts.length > 0 && <p className="muted" role="status">已保留识别结果，重试成功后即可导入</p>}
        {drafts !== undefined && drafts.length > 0 && (
          <section className="candidate-section">
            <h3>识别结果</h3>
            <div className="candidate-list">
              {drafts.map((draft, index) => (
                <div className="candidate-row" key={index}>
                  <div className="candidate-row-header"><strong>公司{index + 1}</strong><button disabled={recognizing || submitting} aria-label={`删除公司 ${index + 1}`} onClick={() => setDrafts((current) => current?.filter((_, draftIndex) => draftIndex !== index))}>删除</button></div>
                  <label>公司名称<input disabled={recognizing || submitting} value={draft.name} onChange={(event) => updateDraft(index, event.target.value)} /></label>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <div className="modal-actions modal-footer">
        <button type="button" disabled={submitting} onClick={close}>取消</button>
        <button className="primary-button" type="button" disabled={recognizing || submitting || recognitionIncomplete || drafts === undefined || drafts.length === 0} onClick={() => void confirm()}>{submitting ? "导入中…" : "确认导入"}</button>
      </div>
    </Modal>
  );
}
