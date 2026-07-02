import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommandToken } from './parseCommandTokens';

/**
 * Renders a transparent layer over the chat textarea that re-draws the same text
 * with known `/command` tokens wrapped in clickable pills.
 *
 * The textarea keeps ownership of editing (its text is made transparent by the
 * caller, caret stays visible); this overlay paints the visible glyphs plus the
 * pills. The backdrop is `pointer-events: none` so caret placement, selection and
 * typing fall through to the textarea, while individual pill spans re-enable
 * pointer events so a click opens the inspect popover.
 *
 * Alignment is achieved by copying the textarea's computed text metrics (the same
 * property set the typeahead mirror uses) and translating the content by the
 * textarea's scroll offset.
 */

// Computed-style properties that affect text layout/wrapping. Mirrors the list in
// Typeahead/typeaheadUtils.ts `getCursorCoordinates` so the overlay lays text out
// identically to the textarea.
const TEXT_STYLE_PROPS = [
  'boxSizing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'wordBreak',
] as const;

interface HighlightOverlayProps {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  tokens: CommandToken[];
  /** Called with the clicked command token and the pill's viewport rect. */
  onPillClick: (token: CommandToken, rect: DOMRect) => void;
}

export const HighlightOverlay: React.FC<HighlightOverlayProps> = ({
  textareaRef,
  value,
  tokens,
  onPillClick,
}) => {
  const [style, setStyle] = useState<React.CSSProperties>({});
  const [scroll, setScroll] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const rafRef = useRef<number | null>(null);

  // Copy text metrics from the live textarea. Re-run on value/size changes so
  // theme/zoom/font/height adjustments stay in sync. getComputedStyle is read in
  // a layout effect (pre-paint) to avoid a one-frame misalignment.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const computed = window.getComputedStyle(ta);
    const next: Record<string, string> = {};
    for (const prop of TEXT_STYLE_PROPS) {
      next[prop] = computed[prop as keyof CSSStyleDeclaration] as string;
    }
    setStyle(next as React.CSSProperties);
    setScroll({ top: ta.scrollTop, left: ta.scrollLeft });
  }, [textareaRef, value]);

  // Keep the overlay's content scrolled with the textarea.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const sync = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setScroll({ top: ta.scrollTop, left: ta.scrollLeft });
      });
    };
    ta.addEventListener('scroll', sync, { passive: true });
    return () => {
      ta.removeEventListener('scroll', sync);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [textareaRef]);

  // Split the value into plain segments and pill spans. Tokens are assumed sorted
  // by start (parseCommandTokens emits them in order).
  const segments = useMemo(() => {
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    tokens.forEach((token, i) => {
      if (token.start > cursor) {
        nodes.push(value.slice(cursor, token.start));
      }
      nodes.push(
        <span
          key={`pill-${token.start}-${i}`}
          className="command-pill"
          data-command-name={token.name}
          style={{ pointerEvents: 'auto', cursor: 'pointer' }}
          // Keep the textarea focused and stop the caret from being placed
          // inside the pill when it is clicked.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onPillClick(token, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
        >
          {value.slice(token.start, token.end)}
        </span>
      );
      cursor = token.end;
    });
    if (cursor < value.length) {
      nodes.push(value.slice(cursor));
    }
    // A trailing newline needs a placeholder so the final line box matches the
    // textarea (which always shows an empty last line). Zero-width space.
    if (value.endsWith('\n')) {
      nodes.push('\u200B');
    }
    return nodes;
  }, [value, tokens, onPillClick]);

  return (
    <div
      aria-hidden="true"
      className="command-pill-overlay absolute inset-0 overflow-hidden pointer-events-none"
      style={{
        ...style,
        // The visible glyphs are painted here (textarea text is transparent).
        color: 'var(--nim-text)',
        borderColor: 'transparent',
        borderStyle: 'solid',
        background: 'transparent',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
      }}
    >
      <div
        className="command-pill-overlay-text"
        style={{
          transform: `translate(${-scroll.left}px, ${-scroll.top}px)`,
          font: 'inherit',
          letterSpacing: 'inherit',
          wordSpacing: 'inherit',
          lineHeight: 'inherit',
          whiteSpace: 'inherit',
          overflowWrap: 'inherit',
          wordBreak: 'inherit',
          textAlign: 'inherit',
          textIndent: 'inherit',
        }}
      >
        {segments}
      </div>
    </div>
  );
};
