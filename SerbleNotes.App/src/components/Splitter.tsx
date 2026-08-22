import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

type Axis = 'x' | 'y';

interface SplitterProps {
  /** Which way the boundary moves. 'x' is a column edge, 'y' is a shelf between stacked panels. */
  axis: Axis;
  /** Which neighbour this handle resizes - the one before it in the DOM, or the one after. */
  resizes: 'previous' | 'next';
  /** What is being resized, for a screen reader. */
  label: string;
  onChange: (size: number) => void;
  /** What a double-click, Home or Enter puts back. */
  onReset: () => void;
  className?: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const along = (element: Element, axis: Axis): number => {
  const rect = element.getBoundingClientRect();
  return axis === 'x' ? rect.width : rect.height;
};

/** The parent's inside, without its padding - which is the space its children actually share. */
const inside = (element: HTMLElement, axis: Axis): number => {
  const style = getComputedStyle(element);
  return axis === 'x'
    ? element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    : element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
};

/**
 * A draggable boundary, between two columns or between two stacked panels.
 *
 * It measures the neighbour it resizes rather than being told how big it is, which is what lets a
 * panel sit at its natural height until the moment someone drags it. There is no minimum and no
 * maximum: a column may be dragged shut, because that is the user's call and not ours - see "Inform,
 * never forbid". The one thing it will not do is let itself be dragged somewhere it cannot be
 * grabbed again, so the size stops at the space actually available and the handle's own position is
 * clamped to stay on screen.
 *
 * It is a `separator` with a value rather than a bare div, which is what makes it reachable and
 * adjustable from the keyboard - a divider that only answers to a mouse is one some people cannot
 * move at all. Arrow keys nudge it, Home puts it back, and so does a double-click.
 */
export function Splitter({ axis, resizes, label, onChange, onReset, className }: SplitterProps) {
  const handle = useRef<HTMLDivElement>(null);
  const from = useRef<{ at: number; size: number } | null>(null);

  // Kept in state only so the separator can report its position honestly to a screen reader.
  const [now, setNow] = useState(0);
  const [room, setRoom] = useState(0);

  const paneOf = useCallback(
    (element: HTMLElement | null): HTMLElement | null =>
      (resizes === 'next' ? element?.nextElementSibling : element?.previousElementSibling) as
        | HTMLElement
        | null,
    [resizes],
  );

  /**
   * How big the pane is allowed to get: everything inside the parent, less the siblings that will
   * not yield. The flexible sibling gives up the space - the editor between the columns, the
   * history below the details - so it is not counted.
   */
  const roomFor = useCallback(
    (element: HTMLElement): number => {
      const pane = paneOf(element);
      const parent = element.parentElement;
      if (!pane || !parent) {
        return 0;
      }

      let taken = 0;
      for (const child of parent.children) {
        if (child === pane) {
          continue;
        }
        const style = getComputedStyle(child);
        if (style.position === 'absolute' || style.display === 'none') {
          continue;
        }
        if (child !== element && parseFloat(style.flexGrow) > 0) {
          continue;
        }
        taken += along(child, axis);
      }

      return Math.max(0, inside(parent, axis) - taken);
    },
    [axis, paneOf],
  );

  useEffect(() => {
    const element = handle.current;
    const pane = paneOf(element);
    const parent = element?.parentElement;
    if (!element || !pane || !parent) {
      return;
    }

    const read = () => {
      setNow(Math.round(along(pane, axis)));
      setRoom(Math.round(roomFor(element)));
    };

    read();
    const observer = new ResizeObserver(read);
    observer.observe(pane);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [axis, paneOf, roomFor]);

  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (from.current === null) {
      return;
    }
    from.current = null;
    document.body.classList.remove('resizing', `resizing-${axis}`);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // Dragging towards the pane makes it bigger, so the two sides read the delta opposite ways.
  const direction = resizes === 'next' ? -1 : 1;

  const nudge = (by: number) => {
    const element = handle.current;
    const pane = paneOf(element);
    if (!element || !pane) {
      return;
    }
    onChange(clamp(along(pane, axis) + by, 0, roomFor(element)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const less = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const more = axis === 'x' ? 'ArrowRight' : 'ArrowDown';

    if (event.key === less) {
      event.preventDefault();
      nudge(-step * direction);
    } else if (event.key === more) {
      event.preventDefault();
      nudge(step * direction);
    } else if (event.key === 'Home' || event.key === 'Enter') {
      event.preventDefault();
      onReset();
    }
  };

  return (
    <div
      ref={handle}
      className={className ? `splitter splitter-${axis} ${className}` : `splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={now}
      aria-valuemin={0}
      aria-valuemax={room}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        const pane = paneOf(event.currentTarget);
        if (event.button !== 0 || !pane) {
          return;
        }
        from.current = {
          at: axis === 'x' ? event.clientX : event.clientY,
          size: along(pane, axis),
        };

        // Capture means the drag keeps working over the editor, and past the window edge.
        event.currentTarget.setPointerCapture(event.pointerId);

        // Without this a drag selects whatever text it passes over, and the cursor flickers
        // between the resize cursor and a text caret.
        document.body.classList.add('resizing', `resizing-${axis}`);
      }}
      onPointerMove={(event) => {
        const start = from.current;
        if (start === null) {
          return;
        }
        const delta = (axis === 'x' ? event.clientX : event.clientY) - start.at;
        onChange(clamp(start.size + delta * direction, 0, roomFor(event.currentTarget)));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
    />
  );
}
