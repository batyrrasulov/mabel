import type { ReactNode } from "react";

type NavGlyphProps = {
  children: ReactNode;
  size?: number;
  strokeWidth?: number;
};

/** Matches ChatGPT sidebar glyphs: 20×20 artboard, thinner stroke. */
function NavGlyph({ children, size = 14, strokeWidth = 1.5 }: NavGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Feather-style folder tab + horizontal divider (ChatGPT Projects). */
export function ProjectsNavIcon({ size = 14, strokeWidth = 1.5 }: { size?: number; strokeWidth?: number }) {
  return (
    <NavGlyph size={size} strokeWidth={strokeWidth}>
      <path d="M18.33 15.83a1.67 1.67 0 0 1-1.67 1.67H3.33a1.67 1.67 0 0 1-1.67-1.67V4.17a1.67 1.67 0 0 1 1.67-1.67h4.17l1.67 2.5h7.5a1.67 1.67 0 0 1 1.67 1.67z" />
      <path d="M2.35 9.5H17.55" strokeLinecap="butt" />
    </NavGlyph>
  );
}

/** Document with folded corner + text lines — standard file glyph, matched to Projects scale. */
export function LibraryNavIcon() {
  return (
    <NavGlyph>
      <path d="M12.5 1.75H5A1.75 1.75 0 0 0 3.25 3.5v13.25A1.75 1.75 0 0 0 5 18.5h10a1.75 1.75 0 0 0 1.75-1.75V5.75L12.5 1.75Z" />
      <path d="M12.5 1.75v3.5h3.5" />
      <path d="M6.5 10.75h7.75" />
      <path d="M6.5 14.25h7.75" />
    </NavGlyph>
  );
}
