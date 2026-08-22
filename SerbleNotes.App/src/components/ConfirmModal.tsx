import type { ReactNode } from 'react';
import { Modal } from './Modal';

interface ConfirmModalProps {
  title: string;
  /** What is about to happen, in a sentence. Say the consequence, not just the action. */
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="modal-body">{body}</div>
      <div className="row end">
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className={danger ? 'primary danger-solid' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
