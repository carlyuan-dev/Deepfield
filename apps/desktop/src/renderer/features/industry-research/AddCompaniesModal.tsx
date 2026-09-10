import { useState } from "react";
import type { CompanyDraft, DesktopApi, ItemCompanyView } from "@deepfield/contracts";
import { Modal } from "./Modal.js";

export interface AddCompaniesModalProps {
  api: DesktopApi;
  itemId: string;
  onClose(): void;
  onCompaniesAdded(companies: ItemCompanyView[]): void;
}

export function AddCompaniesModal({ api, itemId, onClose, onCompaniesAdded }: AddCompaniesModalProps) {
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<CompanyDraft[]>([]);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const addDraft = (): void => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("请填写公司名称");
      return;
    }
    setDrafts((current) => [...current, { name: trimmedName }]);
    setName("");
    setError(undefined);
  };

  const confirmDrafts = async (): Promise<void> => {
    if (submitting || drafts.length === 0) return;
    setSubmitting(true);
    setError(undefined);
    try {
      onCompaniesAdded(await api.industryResearch.addCompanies(itemId, drafts));
      onClose();
    } catch {
      setError("新增失败，请重试");
      setSubmitting(false);
    }
  };

  return (
    <Modal title="添加公司" onClose={onClose}>
      <div className="modal-body company-manager">
        {error !== undefined && <p className="error" role="alert">{error}</p>}
        <section className="draft-entry">
          <label>公司名称<input value={name} disabled={submitting} onChange={(event) => setName(event.target.value)} autoFocus /></label>
          <button type="button" disabled={submitting} onClick={addDraft}>添加到待确认</button>
        </section>
        {drafts.length > 0 && (
          <ul className="draft-list" aria-label="待确认公司">
            {drafts.map((draft, index) => (
              <li key={`${draft.name}-${index}`}>
                <span>{draft.name}</span>
                <button disabled={submitting} aria-label={`删除待确认 ${draft.name}`} onClick={() => setDrafts((current) => current.filter((_, draftIndex) => draftIndex !== index))}>删除</button>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button type="button" disabled={submitting} onClick={onClose}>取消</button>
          <button className="primary-button" type="button" disabled={submitting || drafts.length === 0} onClick={() => void confirmDrafts()}>
            {submitting ? "处理中…" : "确认新增"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
