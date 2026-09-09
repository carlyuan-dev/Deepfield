import { useState, type FormEvent } from "react";
import type { StartCompanyResearchInput } from "@deepfield/contracts";
import { Modal } from "./Modal.js";

export const DEFAULT_COMPANY_RESEARCH_TIME_SCOPE =
  "重点调研近一年，必要的公司背景不限时间";

export interface CompanyResearchModalProps {
  initial?: StartCompanyResearchInput;
  onClose(): void;
  onStart(input: StartCompanyResearchInput): Promise<void>;
}

export function CompanyResearchModal({ initial, onClose, onStart }: CompanyResearchModalProps) {
  const [timeScope, setTimeScope] = useState(
    initial?.timeScope ?? DEFAULT_COMPANY_RESEARCH_TIME_SCOPE,
  );
  const [customRequirements, setCustomRequirements] = useState(
    initial?.customRequirements ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const normalizedTimeScope = timeScope.trim();
    if (normalizedTimeScope.length === 0) {
      setError("请填写调研时间范围");
      return;
    }
    const normalizedRequirements = customRequirements.trim();
    setSubmitting(true);
    setError(undefined);
    try {
      await onStart({
        timeScope: normalizedTimeScope,
        ...(normalizedRequirements.length > 0
          ? { customRequirements: normalizedRequirements }
          : {}),
      });
      onClose();
    } catch {
      setError("无法开始调研，请稍后重试");
      setSubmitting(false);
    }
  };

  return (
    <Modal title="公司调研" onClose={submitting ? () => undefined : onClose}>
      <form className="modal-form" onSubmit={handleSubmit}>
        {error !== undefined && <p className="error" role="alert">{error}</p>}
        <label>
          调研时间范围
          <input
            value={timeScope}
            maxLength={300}
            required
            onChange={(event) => setTimeScope(event.target.value)}
          />
        </label>
        <label>
          补充要求（可选）
          <textarea
            value={customRequirements}
            maxLength={4000}
            rows={5}
            onChange={(event) => setCustomRequirements(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" disabled={submitting} onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={submitting}>
            {submitting ? "正在启动…" : "开始调研"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
