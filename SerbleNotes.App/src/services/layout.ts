/**
 * How the workspace is arranged on this device: how wide the two side columns are, how tall the
 * details panel is, and whether the file tree is showing at all.
 *
 * This is a per-device preference like the collapsed folders in `store.ts`: it says nothing about
 * the vault, so it never goes near the server. Storage can refuse to answer at all in a private
 * window or a locked-down webview, and a workspace that will not draw because it could not read a
 * number is worse than one that opens at its default size - so every path here has a fallback.
 *
 * There are no minimum or maximum sizes. A column dragged shut is a thing someone can want and can
 * see happening, and the tree toggle and the panel toggles bring one back - see "Inform, never
 * forbid". What the splitter does enforce is that its own handle stays on screen, which is about
 * what can be represented rather than about what the user should want.
 */

const KEY = 'serblenotes.layout';

export interface Layout {
  sidebar: number;
  rail: number;
  /** How tall the details panel is, or null for whatever its contents come to. */
  details: number | null;
  /** Desktop only. The narrow layout has a drawer instead, which is transient by nature. */
  treeShut: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  sidebar: 262,
  rail: 320,
  details: null,
  treeShut: false,
};

/** Only guards against what is not a size at all. Anything a drag can produce is kept. */
function size(value: unknown, fallback: number): number {
  const width = Number(value);
  return Number.isFinite(width) && width >= 0 ? Math.round(width) : fallback;
}

export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) {
      return DEFAULT_LAYOUT;
    }

    const stored = JSON.parse(raw) as Partial<Layout>;
    return {
      sidebar: size(stored.sidebar, DEFAULT_LAYOUT.sidebar),
      rail: size(stored.rail, DEFAULT_LAYOUT.rail),
      details:
        stored.details === null || stored.details === undefined
          ? null
          : size(stored.details, DEFAULT_LAYOUT.sidebar),
      treeShut: stored.treeShut === true,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Nowhere to remember it. The layout still works for this session.
  }
}
