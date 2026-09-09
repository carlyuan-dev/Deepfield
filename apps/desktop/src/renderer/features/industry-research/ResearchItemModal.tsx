import { useState, type FormEvent } from "react";
import type { CapabilityItem, DesktopApi } from "@deepfield/contracts";
import { Modal } from "./Modal.js";

export interface ResearchItemModalProps {
  api: DesktopApi;
  item?: CapabilityItem;
  onClose(): void;
  onSaved(item: CapabilityItem): void;
}

function optionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function ResearchItemModal({ api, item, onClose, onSaved }: ResearchItemModalProps) {
  const editing = item !== undefined;
  const [industry, setIndustry] = useState(item?.industry ?? "");
  const [researchScope, setResearchScope] = useState(item?.researchScope ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const trimmedIndustry = industry.trim();
    if (trimmedIndustry.length === 0) {
      setError("请填写行业");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    const normalizedScope = optionalValue(researchScope);
    const normalizedNotes = optionalValue(notes);
    const input = {
      industry: trimmedIndustry,
      ...(normalizedScope !== undefined ? { researchScope: normalizedScope } : {}),
      ...(normalizedNotes !== undefined ? { notes: normalizedNotes } : {}),
    };
    try {
      const saved = editing
        ? await api.industryResearch.updateItem(item.id, input)
        : await api.industryResearch.createItem(input);
      onSaved(saved);
    } catch {
      setError(editing ? "保存失败，请重试" : "创建失败，请重试");
      setSubmitting(false);
    }
  };

  return (
    <Modal title={editing ? "编辑行业" : "添加行业"} onClose={onClose}>
      <form className="modal-form" onSubmit={handleSubmit}>
        {error !== undefined && <p className="error" role="alert">{error}</p>}
        <label>行业<input value={industry} onChange={(event) => setIndustry(event.target.value)} required /></label>
        <label>研究范围（可选）<textarea value={researchScope} onChange={(event) => setResearchScope(event.target.value)} rows={3} /></label>
        <label>备注（可选）<textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
        <div className="modal-actions">
          <button type="button" disabled={submitting} onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? (editing ? "保存中…" : "创建中…") : (editing ? "保存" : "创建")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
