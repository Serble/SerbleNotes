import type { ReactNode } from 'react';
import { CloseIcon } from './Icons';

interface PanelProps {
  title: string;
  /** Shown to the right of the title - one action, not a toolbar. */
  action?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Panels whose body is a long list take the leftover room instead of their content's height. */
  scrolls?: boolean;
  /** Extra classes from the rail - how tall this panel has been dragged, if it has been. */
  className?: string;
}

/**
 * The shell every panel in the side rail shares: a title, one optional action, and a close button.
 *
 * Close is on the panel rather than only on the toolbar toggle that opened it, because on a phone
 * the rail covers the editor and the toggle that opened it is behind the panel.
 */
export function Panel({ title, action, onClose, children, scrolls, className }: PanelProps) {
  return (
    <section
      className={['panel', scrolls ? 'panel-scrolls' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-label={title}
    >
      <header className="panel-head">
        <h3>{title}</h3>
        <div className="panel-head-actions">
          {action}
          <button className="icon" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** A label and a value on one line - what the details panel is made of. */
export function PanelRow({
  label,
  value,
  title,
}: {
  label: string;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div className="panel-row">
      <span className="panel-row-label">{label}</span>
      <span className="panel-row-value" title={title}>
        {value}
      </span>
    </div>
  );
}
