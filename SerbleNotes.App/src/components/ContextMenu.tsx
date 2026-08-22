import { useEffect, useRef, useState } from 'react';

/**
 * The menu that opens on a right-click, wherever in the app something has one.
 *
 * It started in the file tree and is shared because the editor needs the same object: the same
 * looks, the same ways out of it, and the same nudge back inside the window when it opens near an
 * edge. Two menus that behaved slightly differently would be two menus to learn.
 *
 * Dismissal listens for `pointerdown` rather than `mousedown` so that a tap outside closes it on a
 * touchscreen, where the menu is opened by holding a finger down rather than by a right-click and
 * there is no other obvious way out of it. Scrolling closes it too - it is positioned against the
 * window, so text sliding underneath would leave it pointing at the wrong thing.
 */

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  /** Shown but not clickable, with `hint` saying why. Never quietly missing - see "Inform, never forbid". */
  disabled?: boolean;
  hint?: string;
  /** One of a set of choices, and the one currently in force - the column's alignment, say. */
  selected?: boolean;
  run: () => void;
}

/** A rule between groups of items. Purely visual, so it needs nothing but its own name. */
export const SEPARATOR = 'separator';

export type MenuEntry = MenuItem | typeof SEPARATOR;

export interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

/** How far from the window's edge the menu is allowed to sit. */
const MARGIN = 8;

export function ContextMenu({ x, y, items, onClose }: MenuState & { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useEffect(() => {
    // Nudge back inside the window if it opened near an edge.
    const box = panel.current?.getBoundingClientRect();
    if (!box) {
      return;
    }
    setPosition({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - box.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - box.height - MARGIN)),
    });
  }, [x, y, items]);

  useEffect(() => {
    const dismiss = () => onClose();

    /**
     * The page moving under the menu closes it, because the menu is positioned against the window and
     * would end up pointing at something else. The menu scrolling *itself* is not that: it is long
     * enough to need scrolling on a phone, and closing as soon as somebody reached for the item they
     * were scrolling towards made the bottom of it unreachable.
     */
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && panel.current?.contains(event.target)) {
        return;
      }
      onClose();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', dismiss);
    // Capturing, because what scrolls is usually a pane inside the page rather than the page itself,
    // and a scroll event does not bubble.
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      ref={panel}
      style={position}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === SEPARATOR ? (
          <div className="context-sep" key={`sep-${index}`} role="separator" />
        ) : (
          <button
            key={item.label}
            role={item.selected === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.selected}
            className={[
              'context-item',
              item.danger ? 'danger' : '',
              item.selected ? 'on' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
