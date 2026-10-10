/**
 * Inline SVG icons for the sheet toolbar, drawn on a 16px grid with the stroke
 * in `currentColor` so they follow the theme (the FindBar uses the same
 * approach).
 */

import type { ReactNode } from 'react';

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Caret = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"
    className="sheet-toolbar-caret">
    <path d="M1 2.5l3 3 3-3" />
  </svg>
);

export const UndoIcon = () => <Icon><path d="M6 4L3 7l3 3" /><path d="M3 7h6.5a3.5 3.5 0 010 7H7" /></Icon>;
export const RedoIcon = () => <Icon><path d="M10 4l3 3-3 3" /><path d="M13 7H6.5a3.5 3.5 0 000 7H9" /></Icon>;
export const DecimalsLessIcon = () => <Icon size={10}><path d="M12 8H3M6 5L3 8l3 3" /></Icon>;
export const DecimalsMoreIcon = () => <Icon size={10}><path d="M3 8h9M9 5l3 3-3 3" /></Icon>;
export const FillIcon = () => <Icon size={14}><path d="M3 9l5-5 5 5-5 4z" /><path d="M13 11c0 1 .6 2 1 2" /></Icon>;
export const BordersIcon = () => (
  <Icon><rect x="2.5" y="2.5" width="11" height="11" strokeDasharray="1.5 1.5" /><path d="M2.5 8h11M8 2.5v11" /></Icon>
);
export const AlignLeftIcon = () => <Icon><path d="M2 4h12M2 7h8M2 10h12M2 13h8" /></Icon>;
export const AlignCenterIcon = () => <Icon><path d="M2 4h12M4 7h8M2 10h12M4 13h8" /></Icon>;
export const AlignRightIcon = () => <Icon><path d="M2 4h12M6 7h8M2 10h12M6 13h8" /></Icon>;
export const VAlignTopIcon = () => <Icon><path d="M2 2h12M8 13V5M5 8l3-3 3 3" /></Icon>;
export const VAlignMiddleIcon = () => <Icon><path d="M2 8h12M8 1v4M6 3l2 2 2-2M8 15v-4M6 13l2-2 2 2" /></Icon>;
export const VAlignBottomIcon = () => <Icon><path d="M2 14h12M8 3v8M5 8l3 3 3-3" /></Icon>;
export const WrapIcon = () => <Icon><path d="M2 4h12M2 8h9.5a2 2 0 010 4H8M9.5 10.5L8 12l1.5 1.5M2 12h3" /></Icon>;
export const FreezeIcon = () => (
  <Icon><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 6h12M6 2v12" strokeWidth="2.2" /></Icon>
);
export const FilterIcon = () => <Icon><path d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z" /></Icon>;
export const ConditionalIcon = () => (
  <Icon><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 8h12M8 2v12" /><path d="M10 10h4v4h-4z" fill="currentColor" /></Icon>
);
export const NamedRangesIcon = () => (
  <Icon><rect x="2" y="4" width="12" height="8" rx="1" /><path d="M5 10V6l3 4V6M10.5 6v4" /></Icon>
);
export const ValidationIcon = () => <Icon><rect x="2" y="3" width="12" height="10" rx="1" /><path d="M5 8l2 2 4-4" /></Icon>;
export const HideIcon = () => (
  <Icon><path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.6" /><path d="M3 13L13 3" /></Icon>
);
