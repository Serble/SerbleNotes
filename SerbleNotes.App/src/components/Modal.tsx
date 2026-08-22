import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './Icons';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Widen it for content that needs the room, like a list of what a delete would take with it. */
  wide?: boolean;
}

/**
 * The dialog every question in the app is asked through. The browser's own confirm() and prompt()
 * block the whole page, cannot be styled or keyed, and on some platforms offer to suppress
 * themselves - which would silently answer the next question for the user.
 */
export function Modal({ title, onClose, children, wide }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus the first thing worth typing in, or the panel itself, so Escape and Tab land here
    // rather than on whatever was focused behind the backdrop.
    const focusable = panel.current?.querySelector<HTMLElement>(
      'input, textarea, select, button.primary, button',
    );
    (focusable ?? panel.current)?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || !panel.current) {
        return;
      }

      // Keep Tab inside the dialog. Without this the focus ring walks off into the page behind,
      // which for a keyboard user makes the dialog look like it has been dismissed.
      const items = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((item) => !item.hasAttribute('disabled'));
      if (items.length === 0) {
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={wide ? 'modal wide' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="row between modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
