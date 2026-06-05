import { useEffect, useRef } from 'react';
import {
  attachBrowserSession,
  detachBrowserSession,
  setBrowserSessionBounds,
} from '../browserClient';

interface BrowserSurfaceProps {
  sessionId: string;
  /** When false, the surface unmounts the view (e.g. tab inactive). */
  visible: boolean;
}

/**
 * Renders the rectangle that the main-process WebContentsView is positioned
 * over. The component itself draws nothing -- a transparent placeholder div
 * reserves the space and reports its layout to BrowserSessionService so the
 * native view overlays exactly the right area of the host window.
 *
 * Key contract:
 *   - On mount + visibility=true: attach the view at the current rect.
 *   - On every layout change (resize, scroll, parent reflow): push new bounds.
 *   - On unmount or visibility=false: detach (the view is preserved so we
 *     don't re-paint on every tab switch).
 *
 * We intentionally don't destroy the session here -- the parent editor owns
 * the session lifecycle (it persists across source-mode toggles, for example).
 */
export function BrowserSurface({ sessionId, visible }: BrowserSurfaceProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track the last-pushed bounds so we don't spam IPC during rAF-paced resize.
  const lastBoundsRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const attachedRef = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!visible) {
      if (attachedRef.current) {
        void detachBrowserSession(sessionId);
        attachedRef.current = false;
        lastBoundsRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const rectsIntersect = (
      a: { left: number; top: number; right: number; bottom: number },
      b: { left: number; top: number; right: number; bottom: number },
    ): boolean =>
      !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

    // A native WebContentsView always paints above the DOM, so any host menu,
    // dropdown, tooltip, or popover that overlaps the browser rectangle would
    // be occluded by the live page. @floating-ui's FloatingPortal mounts these
    // overlays as direct children of <body>, as siblings of the React app root
    // (which contains our placeholder). If any such portal subtree has a
    // visible element overlapping the surface, we hide the native view so the
    // overlay is fully visible; it re-attaches when the overlay closes.
    const overlayCoversSurface = (surfaceRect: {
      left: number;
      top: number;
      right: number;
      bottom: number;
    }): boolean => {
      const body = document.body;
      if (!body) return false;
      for (let i = 0; i < body.children.length; i++) {
        const child = body.children[i];
        // Skip the app root (it contains our own placeholder) and non-visual
        // nodes. Everything else under <body> is a portal/overlay layer.
        if (child === el || child.contains(el)) continue;
        const tag = child.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'TEMPLATE') continue;
        const r0 = child.getBoundingClientRect();
        if (r0.width > 0 && r0.height > 0 && rectsIntersect(r0, surfaceRect)) return true;
        // The portal wrapper itself is often a zero-size container; inspect its
        // descendants for the actual floating element.
        const nodes = child.querySelectorAll('*');
        for (let j = 0; j < nodes.length; j++) {
          const r = nodes[j].getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && rectsIntersect(r, surfaceRect)) return true;
        }
      }
      return false;
    };

    const computeBounds = (): { x: number; y: number; width: number; height: number } | null => {
      // A native WebContentsView ignores CSS, so a placeholder hidden via
      // `display:none` (inactive tab, Files<->Agent mode switch, collapsed
      // pane) still leaves the view floating on top of whatever is now on
      // screen. `offsetParent === null` detects display:none; a zero-size rect
      // covers the remaining cases. Either means "not on screen" -> no bounds.
      if (el.offsetParent === null) return null;
      const rect = el.getBoundingClientRect();
      // Bounds are CSS pixels relative to the host window's content area.
      // The renderer's <body> origin lines up with the content area origin in
      // a normal Electron window, so getBoundingClientRect (which is relative
      // to the viewport) is the correct frame of reference.
      const x = Math.round(rect.left);
      const y = Math.round(rect.top);
      const width = Math.max(0, Math.round(rect.width));
      const height = Math.max(0, Math.round(rect.height));
      if (width === 0 || height === 0) return null;
      // If a host menu/popover/tooltip is open over us, hide the view so the
      // overlay isn't clipped by the native layer.
      if (overlayCoversSurface({ left: x, top: y, right: x + width, bottom: y + height })) {
        return null;
      }
      return { x, y, width, height };
    };

    const pushBounds = async (): Promise<void> => {
      if (cancelled) return;
      const bounds = computeBounds();
      if (!bounds) {
        // Placeholder is not on screen. Detach the native view so it stops
        // covering the now-visible content (other tab, agent mode, etc.).
        // It re-attaches below once the placeholder is laid out again.
        if (attachedRef.current) {
          void detachBrowserSession(sessionId);
          attachedRef.current = false;
          lastBoundsRef.current = null;
        }
        return;
      }
      const last = lastBoundsRef.current;
      if (
        last &&
        last.x === bounds.x &&
        last.y === bounds.y &&
        last.w === bounds.width &&
        last.h === bounds.height
      ) {
        return;
      }
      lastBoundsRef.current = { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
      try {
        if (!attachedRef.current) {
          await attachBrowserSession(sessionId, bounds);
          attachedRef.current = true;
        } else {
          await setBrowserSessionBounds(sessionId, bounds);
        }
      } catch (err) {
        // If attach fails (e.g. session was destroyed under us), drop the
        // attached flag so a later visibility flip re-tries from scratch.
        attachedRef.current = false;
        console.warn('[BrowserSurface] attach/setBounds failed:', err);
      }
    };

    // Watch for size changes via ResizeObserver, scroll/layout changes via
    // window resize, and use rAF for the first paint so the initial bounds
    // reflect the laid-out rect rather than a pre-layout zero-size box.
    const ro = new ResizeObserver(() => {
      void pushBounds();
    });
    ro.observe(el);

    // IntersectionObserver catches visibility flips that ResizeObserver can
    // miss -- e.g. the placeholder being shown/hidden via `display:none` on an
    // ancestor (tab switch, mode switch) where our own box size is unchanged,
    // or scrolled in/out of view. Both attach (re-show) and detach (hide) are
    // driven through pushBounds, which re-checks on-screen state.
    const io = new IntersectionObserver(() => {
      void pushBounds();
    });
    io.observe(el);

    // Menus/popovers don't change our box, so neither observer above fires when
    // one opens over us. Watch <body> for portal nodes being added/removed and
    // re-evaluate. Coalesced to once per frame; the overlay scan only inspects
    // body-level portal subtrees (it skips the app root), so this stays cheap.
    let moRaf = 0;
    const mo = new MutationObserver(() => {
      if (moRaf) return;
      moRaf = requestAnimationFrame(() => {
        moRaf = 0;
        void pushBounds();
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });

    const onWindowResize = (): void => {
      void pushBounds();
    };
    window.addEventListener('resize', onWindowResize);

    // Push a coarse refresh every animation frame for the first second so
    // bounds catch up to layout-driven reflows (tab pane animations, sidebar
    // expand/collapse) that ResizeObserver may miss if our container's box
    // doesn't change.
    const t0 = performance.now();
    let raf = requestAnimationFrame(function tick() {
      void pushBounds();
      if (performance.now() - t0 < 1000 && !cancelled) {
        raf = requestAnimationFrame(tick);
      }
    });

    return (): void => {
      cancelled = true;
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      if (moRaf) cancelAnimationFrame(moRaf);
      window.removeEventListener('resize', onWindowResize);
      cancelAnimationFrame(raf);
      if (attachedRef.current) {
        void detachBrowserSession(sessionId);
        attachedRef.current = false;
        lastBoundsRef.current = null;
      }
    };
  }, [sessionId, visible]);

  return (
    <div
      ref={containerRef}
      className="nim-browser-surface"
      data-session-id={sessionId}
      style={{
        flex: '1 1 auto',
        minHeight: 0,
        backgroundColor: 'transparent',
      }}
    />
  );
}
