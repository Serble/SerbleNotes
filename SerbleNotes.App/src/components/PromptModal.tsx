import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';

interface PromptModalProps {
  title: string;
  label: string;
  description?: ReactNode;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptModal({
  title,
  label,
  description,
  initialValue = '',
  placeholder,
  confirmLabel,
  onSubmit,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);

  return (
    <Modal title={title} onClose={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        {description && <p className="muted small modal-body">{description}</p>}
        <label>
          {label}
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            autoFocus
          />
        </label>
        <div className="row end">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
