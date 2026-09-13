/**
 * The menu bar strip's markup.
 *
 * The offscreen window renders the same markup the design mockups use, so
 * `nimbalyst-local/mockups/menu-bar-strip-variants.mockup.html` and
 * `menu-bar-session-name.mockup.html` are the implementation reference rather
 * than a picture of one. Pure string building -- no Electron, no I/O.
 *
 * One colour palette, tuned for a dark menu bar, and a white foreground.
 * The macOS menu bar is *translucent*, so a dark wallpaper makes it look dark
 * even in Light Mode, and there is no Electron API for its real luminance.
 * Template images dodge this because macOS tints them at the `NSStatusBar`
 * level, but a template image is monochrome, which is exactly what a
 * multi-colour state strip is not. Hardcoding white is the same compromise
 * `getIconForState` already makes for the colour-dot icon; the strip just gives
 * it more surface. Worth looking at on a real machine against both a light and
 * a dark wallpaper -- not worth reasoning about further here.
 */

import { FLEET_STRIP_COLORS as COLORS } from '../../shared/fleetStripColors';
import type { StripView } from './stripStateMachine';

/**
 * Menu bar item height in DIP.
 *
 * Kept as small as the glyph allows. macOS gives a status item roughly 22pt of
 * content height and scales anything taller down to fit -- which would shrink
 * the text along with the glyph, the opposite of what growing the canvas is for.
 */
export const STRIP_HEIGHT = 18;

/**
 * Glyph size in DIP -- the knob to turn if the icon reads too small or too large.
 *
 * The template PNG carries its own padding: only 27 of its 32 pixels are ink, so
 * the visible mark is about 85% of this number. At the original 15px the mark
 * came out near 12.7pt, noticeably lighter than the neighbouring menu bar icons.
 */
const GLYPH_SIZE = 18;

/** Hard ceiling on the offscreen canvas, and therefore on a captured strip. */
export const STRIP_MAX_WIDTH = 300;

const FOREGROUND = 'rgba(255,255,255,0.94)';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pair(color: string, count: number): string {
  return `<span class="pair"><span class="d" style="background:${color}"></span>`
    + `<span class="n" style="color:${color}">${count}</span></span>`;
}

/**
 * The dynamic part of the strip -- everything after the app glyph.
 *
 * Zeroes are dropped rather than shown as `0`: a permanently wide menu bar item
 * is a permanently expensive one, and menu bar items that overflow vanish
 * silently under the notch.
 */
export function renderStripBody(view: StripView): string {
  const parts: string[] = [];

  if (view.mode === 'named') {
    parts.push(`<span class="leaddot" style="background:${COLORS[view.state]}"></span>`);
    parts.push(`<span class="name">${escapeHtml(view.title)}</span>`);
  } else {
    // Approval and decision collapse into one amber "waiting" count. The
    // distinction is what the named form's dot is for; at resting width two
    // near-identical dot-and-digit pairs would cost width to say less.
    const waiting = view.needsApproval + view.needsDecision;
    if (waiting > 0) parts.push(pair(COLORS.approval, waiting));
    if (view.running > 0) parts.push(pair(COLORS.running, view.running));
    if (view.stalled > 0) parts.push(pair(COLORS.stalled, view.stalled));
    if (view.failed > 0) parts.push(pair(COLORS.failed, view.failed));
    // Finished while you were away and not yet read. The old `setTitle` counted
    // these, and dropping them meant a session that completed in the background
    // left nothing at all in the menu bar.
    if (view.unread > 0) parts.push(pair(COLORS.completed, view.unread));
  }

  if (view.age) {
    const hot = view.age.hot ? ' hot' : '';
    parts.push(`<span class="age${hot}">${escapeHtml(view.age.label)}</span>`);
  }

  return parts.join('');
}

/**
 * The offscreen document. Loaded once; `__nimSetStrip` swaps the body and
 * reports the laid-out width so the capture rect is measured, not guessed.
 *
 * `glyphDataUri` is the existing tray template PNG inlined as a CSS mask, so the
 * strip carries the real app glyph and picks up the foreground colour. A `data:`
 * document cannot load `file://` images, hence the inline.
 */
export function stripDocumentHtml(glyphDataUri: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: transparent;
    height: ${STRIP_HEIGHT}px;
    overflow: hidden;
    font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif;
  }
  .strip {
    display: inline-flex; align-items: center; gap: 6px;
    height: ${STRIP_HEIGHT}px; padding-right: 2px;
    font-size: 13px; line-height: 1; white-space: nowrap;
    color: ${FOREGROUND};
  }
  #strip-body { display: contents; }
  .glyph {
    width: ${GLYPH_SIZE}px; height: ${GLYPH_SIZE}px; flex-shrink: 0;
    background: ${FOREGROUND};
    -webkit-mask: url("${glyphDataUri}") center / contain no-repeat;
  }
  .pair { display: inline-flex; align-items: center; gap: 3.5px; }
  .pair .d { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .pair .n { font-variant-numeric: tabular-nums; font-weight: 500; font-size: 12.5px; }
  .leaddot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .name {
    max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500; font-size: 12.5px;
  }
  /*
   * The age is the one element allowed to change without a real transition, so
   * it must not move its neighbours as it grows -- menu bar items lay out
   * right-to-left, and a strip that changes width shoves everything to its left.
   * Tabular figures plus a reserved box wide enough for the longest form.
   */
  .age {
    font-variant-numeric: tabular-nums; opacity: 0.6;
    min-width: 34px; flex-shrink: 0;
  }
  .age.hot { opacity: 1; color: ${COLORS.approval}; font-weight: 600; }
</style></head>
<body>
<div class="strip" id="strip"><span class="glyph"></span><span id="strip-body"></span></div>
<script>
  window.__nimSetStrip = (html) => new Promise((resolve) => {
    const body = document.getElementById('strip-body');
    const strip = document.getElementById('strip');
    body.innerHTML = html;
    // Two frames: the first lays out, the second guarantees the compositor has
    // painted what capturePage is about to read.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve(Math.ceil(strip.getBoundingClientRect().width));
    }));
  });
</script>
</body>
</html>`;
}
