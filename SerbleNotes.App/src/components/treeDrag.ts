import { useEffect, useRef, useState } from 'react';
import type { MenuEntry } from './ContextMenu';

/**
 * Dragging a row with a finger, in a tree that already drags with a mouse.
 *
 * HTML5 drag and drop is never fired for a touch, so without this a phone can only file a note
 * through "Move to...". A long press already means something here, so one gesture does both jobs:
 * the context menu opens at MENU_MS, and holding through it takes the menu away again and lifts the
 * row. Holding too long therefore costs one more press rather than the wrong action.
 *
 * Two things about it are not preference. The rows are not `touch-action: none` - that would cost
 * the sidebar its scrolling for the whole of the tree - so a scroll is stopped instead by
 * preventing the `touchmove` that would start one, which needs a native listener with
 * `passive: false` because React registers its own as passive. And what is under the finger is
 * asked of `document.elementFromPoint`: a touch is delivered to the element it started on for its
 * whole life, so no other row ever hears about the drag and there are no hover events to wait for.
 */

/** How long the finger stays still before the context menu opens. Matches the editor's own press. */
const MENU_MS = 500;

/**
 * And how long before the menu gives way to the drag. The gap is what somebody reading the menu has
 * to lift their finger in, so it is generous - a drag that starts too eagerly turns every menu into
 * a fight, and being a fraction slow to pick a note up costs nothing.
 */
const DRAG_MS = 1100;

/** How far the finger may drift in that time and still count as a press rather than a scroll. */
const SLOP = 10;

/** Hovering a shut folder for this long opens it, exactly as hovering with a mouse does. */
const HOVER_MS = 600;

/** How close to the end of the scrolling column the finger starts moving it. */
const SCROLL_EDGE = 56;

/** Pixels per millisecond at the very edge, tapering to nothing at the top of the band. */
const SCROLL_SPEED = 0.9;

/** Which folder a row means as a drop target. A note row means the folder it is sitting in. */
export const DROP_ATTR = 'data-drop';

/** Marks a folder row that is shut, so hovering it can open it mid-drag. */
export const SHUT_ATTR = 'data-shut';

export interface TouchPress<T> {
  /** What holding this row picks up. Null for the empty space, which has a menu and nothing to lift. */
  item: T | null;
  /** The menu that opens first, built at the moment of the press like every other menu here. */
  menu: MenuEntry[];
}

export interface TouchDragOptions<T> {
  /** The tree itself: the listeners hang off it, and its box is the boundary of the drop area. */
  container: React.RefObject<HTMLElement | null>;
  openMenu: (x: number, y: number, items: MenuEntry[]) => void;
  closeMenu: () => void;
  /** The folder under the finger - '' for the top level, null for nowhere. */
  onOver: (folder: string | null) => void;
  /** Opens a shut folder the finger has settled on. */
  reveal: (folder: string) => void;
  drop: (folder: string, item: T) => void;
}

export interface TouchDrag<T> {
  /** Call from a row's `onTouchStart`. */
  start: (event: React.TouchEvent, press: TouchPress<T>) => void;
  /** What is being dragged, for drawing it. Null when nothing is. */
  dragging: { item: T } | null;
  /**
   * Put this on the thing that follows the finger. It is moved by writing to its style rather than
   * by re-rendering: a touchmove arrives on every frame the finger moves, and a tree of a couple of
   * hundred rows cannot be rebuilt that often - the same reason the mouse drag keeps what it is
   * carrying in a module variable rather than in state.
   */
  ghost: React.RefObject<HTMLDivElement>;
}

/** The nearest ancestor that actually scrolls, which is what a drag near the edge has to move. */
function scrollerFor(from: HTMLElement | null): HTMLElement | null {
  for (let node: HTMLElement | null = from; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

export function useTouchDrag<T>(options: TouchDragOptions<T>): TouchDrag<T> {
  // The listeners are bound once and the options change every render, so they are read through a
  // ref rather than being a reason to tear the listeners down and put them back.
  const latest = useRef(options);
  latest.current = options;

  const [dragging, setDragging] = useState<{ item: T } | null>(null);
  const ghost = useRef<HTMLDivElement>(null);

  const timers = useRef<{ menu?: number; drag?: number; hover?: number }>({});
  const frame = useRef(0);
  const lastFrame = useRef(0);
  const at = useRef({ x: 0, y: 0 });
  // A synchronous mirror of `dragging`: touchmove has to know whether it is in a drag before React
  // has re-rendered anything, and it has to know it without closing over a stale render's state.
  const held = useRef<T | null>(null);
  const over = useRef<string | null>(null);
  const hovering = useRef<string | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  // Set when a press did something of its own, so the click the browser synthesises from the touch
  // does not also open the note that was underneath the menu, or the one that was just dragged.
  const swallow = useRef(false);
  /**
   * The drag is started from the press handler, which is rebuilt on every render, but everything it
   * touches lives inside the effect below with the listeners that share it. This ref is the one wire
   * between the two.
   */
  const beginRef = useRef<(item: T, x: number, y: number) => void>(() => {});

  /** Moves what is being carried to where the finger is. Only refs, so it is safe to close over. */
  const place = () => {
    const el = ghost.current;
    if (el) {
      el.style.left = `${at.current.x}px`;
      el.style.top = `${at.current.y}px`;
    }
  };

  // The ghost does not exist until the render that the drag starting caused, so its first position
  // is set here rather than in `begin`.
  useEffect(place);

  useEffect(() => {
    const el = latest.current.container.current;
    if (!el) {
      return;
    }

    const clearTimers = () => {
      window.clearTimeout(timers.current.menu);
      window.clearTimeout(timers.current.drag);
      window.clearTimeout(timers.current.hover);
      timers.current = {};
      hovering.current = null;
    };

    const folderAt = (x: number, y: number): string | null => {
      const row = document.elementFromPoint(x, y)?.closest(`[${DROP_ATTR}]`);
      if (row) {
        return row.getAttribute(DROP_ATTR);
      }
      // Anything else inside the tree is the empty space below the last row, which is the top level.
      const box = el.getBoundingClientRect();
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      return inside ? '' : null;
    };

    /** Where the finger now is, what that means, and whether a shut folder should open under it. */
    const aim = () => {
      const { x, y } = at.current;
      const folder = folderAt(x, y);
      if (folder !== over.current) {
        over.current = folder;
        latest.current.onOver(folder);
      }

      const row = document.elementFromPoint(x, y)?.closest(`[${DROP_ATTR}]`);
      const shut = row?.hasAttribute(SHUT_ATTR) ? row.getAttribute(DROP_ATTR) : null;
      if (shut !== hovering.current) {
        window.clearTimeout(timers.current.hover);
        hovering.current = shut;
        if (shut !== null) {
          timers.current.hover = window.setTimeout(() => latest.current.reveal(shut), HOVER_MS);
        }
      }
    };

    /** Scrolls the column while the finger sits near either end of it, and re-aims as it moves. */
    const tick = (now: number) => {
      frame.current = requestAnimationFrame(tick);
      const elapsed = Math.min(now - lastFrame.current, 50);
      lastFrame.current = now;

      const column = scroller.current;
      if (!column) {
        return;
      }
      const box = column.getBoundingClientRect();
      const above = at.current.y - box.top;
      const below = box.bottom - at.current.y;
      let by = 0;
      if (above < SCROLL_EDGE) {
        by = -((SCROLL_EDGE - above) / SCROLL_EDGE) * SCROLL_SPEED * elapsed;
      } else if (below < SCROLL_EDGE) {
        by = ((SCROLL_EDGE - below) / SCROLL_EDGE) * SCROLL_SPEED * elapsed;
      }
      if (by === 0) {
        return;
      }

      const before = column.scrollTop;
      column.scrollTop = before + by;
      // The rows moved under a finger that did not, so what it is pointing at has changed.
      if (column.scrollTop !== before) {
        aim();
      }
    };

    const begin = (item: T, x: number, y: number) => {
      // The menu was the first half of this gesture; the drag is the second, and two things on the
      // screen claiming the same finger would be one too many.
      latest.current.closeMenu();
      held.current = item;
      over.current = null;
      at.current = { x, y };
      setDragging({ item });
      // The row lifting is the visible half of saying the mode changed; this is the felt half, on
      // the platforms that have it. Nothing depends on it.
      navigator.vibrate?.(12);

      scroller.current = scrollerFor(el);
      lastFrame.current = performance.now();
      frame.current = requestAnimationFrame(tick);
      aim();
    };
    beginRef.current = begin;

    const finish = () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearTimers();
      const item = held.current;
      held.current = null;
      scroller.current = null;
      setDragging(null);
      latest.current.onOver(null);
      const folder = over.current;
      over.current = null;
      if (item !== null && folder !== null) {
        latest.current.drop(folder, item);
      }
    };

    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }

      if (held.current === null) {
        // Still deciding what this press is. Any real movement makes it a scroll or a selection,
        // and the menu, if it is already up, is left to its own ways out.
        if (
          Math.abs(touch.clientX - at.current.x) > SLOP ||
          Math.abs(touch.clientY - at.current.y) > SLOP
        ) {
          window.clearTimeout(timers.current.menu);
          window.clearTimeout(timers.current.drag);
        }
        return;
      }

      // Cancelable because the drag only ever begins after a second of stillness, so the browser
      // has not started scrolling and this is what stops it starting now.
      event.preventDefault();
      at.current = { x: touch.clientX, y: touch.clientY };
      place();
      aim();
    };

    const end = () => {
      if (held.current !== null) {
        swallow.current = true;
        finish();
        return;
      }
      clearTimers();
    };

    const cancelled = () => {
      if (held.current !== null) {
        // A cancelled touch is the system taking the finger away, not a drop: put the row back.
        over.current = null;
      }
      end();
    };

    /**
     * The click the browser makes out of the touch. It targets what was under the finger when the
     * press began - the row - so without this a press that opened a menu or moved a note would also
     * open the note underneath it. A flag left set by a touch that never produced a click is
     * cleared by the next press rather than by a timer.
     */
    const click = (event: MouseEvent) => {
      if (!swallow.current) {
        return;
      }
      swallow.current = false;
      event.preventDefault();
      event.stopPropagation();
    };

    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancelled);
    el.addEventListener('click', click, true);
    return () => {
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', cancelled);
      el.removeEventListener('click', click, true);
      cancelAnimationFrame(frame.current);
      clearTimers();
    };
  }, []);

  const start = (event: React.TouchEvent, press: TouchPress<T>) => {
    swallow.current = false;
    window.clearTimeout(timers.current.menu);
    window.clearTimeout(timers.current.drag);

    const touch = event.touches[0];
    // A second finger is a pinch or a scroll, and neither is this.
    if (!touch || event.touches.length > 1) {
      return;
    }

    at.current = { x: touch.clientX, y: touch.clientY };
    const { x, y } = at.current;
    timers.current.menu = window.setTimeout(() => {
      swallow.current = true;
      latest.current.openMenu(x, y, press.menu);
    }, MENU_MS);

    const item = press.item;
    if (item !== null) {
      timers.current.drag = window.setTimeout(() => beginRef.current(item, x, y), DRAG_MS);
    }
  };

  return { start, dragging, ghost };
}

/**
 * What a row has to say to be a drop target. Written by the tree, read back out of the document by
 * the drag - so they are one function rather than two spellings of the same attribute name.
 */
export function dropTarget(folder: string, shut = false): Record<string, string> {
  return shut ? { [DROP_ATTR]: folder, [SHUT_ATTR]: '' } : { [DROP_ATTR]: folder };
}
