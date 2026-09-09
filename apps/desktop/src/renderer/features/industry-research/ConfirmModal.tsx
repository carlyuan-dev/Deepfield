import { Modal } from "./Modal.js";

export interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  error: string | undefined;
  onClose(): void;
  onConfirm(): void;
}

export function ConfirmModal({ title, message, confirmLabel, busy, error, onClose, onConfirm }: ConfirmModalProps) {
  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose}>
      <div className="modal-body confirmation-modal">
        <p>{message}</p>
        {error !== undefined && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="danger-button" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "处理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
