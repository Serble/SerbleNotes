interface IconProps {
  size?: number;
}

/*
 * One weight for the whole set. 2.2 rather than the 1.8 this started at: these are drawn at 16-18px
 * against a dark ground, where a hairline goes grey and reads as disabled rather than quiet. A
 * heavier line also only survives if the drawing under it is simple, which is why the glyphs below
 * are two or three strokes each - detail that was legible at 1.8 fills in at 2.2.
 */
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/*
 * The product mark: the page is the power ring. Its top edge breaks for the power stem, and what is
 * written inside is the note. It is drawn on the same 24 grid as every other icon here, so it sits
 * on a line of text with no special handling - but it packs three horizontal strokes into a small
 * space, so do not render it much below 18px, where they merge into a block. public/favicon.svg is
 * the same mark on a 64 grid for the browser tab; if one changes, change the other.
 */
export const LogoIcon = ({ size = 18 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M14.5 4H17a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h2.5" />
    <path d="M12 2.8V9" />
    <path d="M7.5 13.5h9" />
    <path d="M7.5 17h6" />
  </svg>
);

export const LockIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
    <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
  </svg>
);

export const UnlockedIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
    <path d="M8 10.5V7a4 4 0 0 1 7-2.6" />
  </svg>
);

export const PlusIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const HistoryIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </svg>
);

/* A lid and a straight-sided tub. The tapered body and its separate handle closed up at this weight. */
export const TrashIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M4 6.5h16" />
    <path d="M10 4h4" />
    <path d="M6.5 6.5v12A1.5 1.5 0 0 0 8 20h8a1.5 1.5 0 0 0 1.5-1.5v-12" />
  </svg>
);

export const BackIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const FolderIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

/* The back of the folder and the flap in front of it, meeting only at the bottom left corner: at
   this weight the old drawing had the two overlapping along their whole length and filled in. */
export const FolderOpenIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M3.5 18.5V7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v1.5" />
    <path d="M3.5 18.5l2.8-7h15l-2.8 7z" />
  </svg>
);

export const NoteIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
  </svg>
);

export const RenameIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M4 20h16" />
    <path d="M14.5 4.5l5 5L9 20H4v-5z" />
  </svg>
);

export const FolderPlusIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11.5v4M10 13.5h4" />
  </svg>
);

export const ChevronRightIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const ChevronDownIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M5 9l7 7 7-7" />
  </svg>
);

export const SearchIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </svg>
);

export const CloseIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const MoveIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M12 3v18M3 12h18" />
    <path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
  </svg>
);

export const TagIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M4 4h7l9 9-7 7-9-9z" />
    <circle cx="8.5" cy="8.5" r="1.4" />
  </svg>
);

export const MenuIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const InfoIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 8h.01" />
  </svg>
);

/* A door, and the way out of it: the arrow leaves to the right, which is where leaving is drawn. */
export const SignOutIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M13 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H13" />
    <path d="M17 8.5l3.5 3.5-3.5 3.5" />
    <path d="M10 12h10.5" />
  </svg>
);

/*
 * A door, a dial, and the handle beside it. The two ticks that used to sit above and below the dial
 * were a pixel each at 16px; replacing them with a single spoke through it drew a power symbol,
 * which is the product's own mark and cannot also mean "vault". The handle is outside the dial for
 * that reason rather than for looks.
 */
export const VaultIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="11" cy="12" r="3.5" />
    <path d="M16 12h2" />
  </svg>
);

/* A ring and a flat shaft. Laid diagonally, the teeth ran into the ring below about 20px. */
export const KeyIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <circle cx="7.5" cy="12" r="4" />
    <path d="M11.5 12H20" />
    <path d="M17 12v3.5" />
  </svg>
);

export const ExportIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M12 3v12" />
    <path d="M8 11l4 4 4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

export const ImportIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M12 15V3" />
    <path d="M8 7l4-4 4 4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

/** Chevrons folding in towards a line: everything closes up to here. */
export const CollapseAllIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M4 12h16" />
    <path d="M7.5 4.5l4.5 4 4.5-4" />
    <path d="M7.5 19.5l4.5-4 4.5 4" />
  </svg>
);

/** The same chevrons opening away from it. */
export const ExpandAllIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M4 12h16" />
    <path d="M7.5 8l4.5-4 4.5 4" />
    <path d="M7.5 16l4.5 4 4.5-4" />
  </svg>
);

export const CopyIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
  </svg>
);

export const CheckIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);
