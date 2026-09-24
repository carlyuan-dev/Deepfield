import { useState, type FormEvent } from "react";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import type { CompanyProfileIdentityHint, ItemCompanyView } from "../contracts/index.js";
import { Modal } from "../../../apps/desktop/src/renderer/components/Modal.js";
import { useFormField, type FormControl } from "./form-control.js";

function isHttpWebsite(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export interface CompanyIdentityConfirmationModalProps {
  control?: FormControl;
  api: DesktopApi;
  company: ItemCompanyView;
  active?: boolean;
  onClose(): void;
  onConfirmed(hint: CompanyProfileIdentityHint): void;
}

export function CompanyIdentityConfirmationModal({ api, company, control, active = true, onClose, onConfirmed }: CompanyIdentityConfirmationModalProps) {
  const [name, setName] = useFormField(control, "name", company.profileIdentityHint?.name ?? "");
  const [officialWebsite, setOfficialWebsite] = useFormField(control, "officialWebsite", company.profileIdentityHint?.officialWebsite ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const provenanceIdentity = company.profileProvenance?.identity;
  const reason = provenanceIdentity !== undefined && provenanceIdentity.disposition !== "matched"
    ? provenanceIdentity.reason
    : undefined;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const preciseName = name.trim();
    const website = officialWebsite.trim();
    if (!preciseName) {
      setError("请输入精确主体名称");
      return;
    }
    if (website && !isHttpWebsite(website)) {
      setError("请输入 http:// 或 https:// 开头的网站地址");
      return;
    }
    const hint = { name: preciseName, ...(website ? { officialWebsite: website } : {}) };
    setBusy(true);
    setError(undefined);
    try {
      if (control) { await control.confirm(); return; }
      const accepted = await api.industryResearch.confirmCompanyProfileIdentity(company.id, hint);
      if (!accepted) {
        setError("公司状态已变化，请刷新后重试");
        return;
      }
      onConfirmed(hint);
    } catch {
      setError("确认失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="确认公司主体" active={active} onClose={() => { if (!busy) onClose(); }}>
      <form className="modal-form identity-confirmation-form" onSubmit={(event) => void submit(event)}>
        {reason && <div className="identity-confirmation-reason"><strong>待确认原因</strong><p>{reason}</p></div>}
        {!reason && <p className="muted">上次补全未完成，可修改已保存的主体信息后继续。</p>}
        <p className="muted">此公司为全局公司；确认内容会对所有研究主题生效。</p>
        <label>精确主体名称<input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label>官方网站（可选）<input value={officialWebsite} onChange={(event) => setOfficialWebsite(event.target.value)} placeholder="https://example.com" /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "确认中…" : "确认并继续补全"}</button>
        </div>
      </form>
    </Modal>
  );
}
