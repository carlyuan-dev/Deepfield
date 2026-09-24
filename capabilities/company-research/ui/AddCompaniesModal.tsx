import { useState } from "react";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import type { CompanyDraft, ItemCompanyView } from "../contracts/index.js";
import { Modal } from "../../../apps/desktop/src/renderer/components/Modal.js";
import { useFormField, type FormControl } from "./form-control.js";

export interface AddCompaniesModalProps {
  control?: FormControl;
  api: DesktopApi;
  itemId: string;
  active?: boolean;
  onClose(): void;
  onCompaniesAdded(companies: ItemCompanyView[]): void;
}

export function AddCompaniesModal({ api, itemId, control, active = true, onClose, onCompaniesAdded }: AddCompaniesModalProps) {
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useFormField<CompanyDraft[]>(control, "companies", []);
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
      if (control) { await control.confirm(); return; }
      onCompaniesAdded(await api.industryResearch.addCompanies(itemId, drafts));
      onClose();
    } catch {
      setError("新增失败，请重试");
      setSubmitting(false);
    }
  };

  return (
    <Modal title="添加公司" active={active} onClose={onClose}>
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
