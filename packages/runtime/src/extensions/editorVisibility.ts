/**
 * Element visibility tracking for editor hosts.
 *
 * Nimbalyst keeps editors mounted while hidden (inactive tabs, hidden modes)
 * by toggling `display: none` on ancestor elements. An IntersectionObserver
 * on the editor's root element detects both cases without any plumbing from
 * the tab bar or mode switcher: `display: none` anywhere in the ancestor
 * chain reports as not intersecting.
 *
 * Backs `EditorHost.visible` / `EditorHost.onVisibilityChanged`.
 */

export interface VisibilityTracker {
  /** Current visibility (last observed state). */
  getVisible(): boolean;

  /** Subscribe to visibility changes. Fires only on actual transitions. */
  subscribe(callback: (visible: boolean) => void): () => void;

  /** Stop observing and drop all subscribers. */
  disconnect(): void;
}

/**
 * Track whether an element is rendered on screen.
 *
 * Uses IntersectionObserver against the viewport with threshold 0: any
 * visible pixel counts as visible. Scrolled-out-but-displayed editors fill
 * their pane in practice, so this maps 1:1 to the display-toggle residency
 * model. Falls back to always-visible when IntersectionObserver is
 * unavailable (jsdom, very old runtimes).
 */
export function createElementVisibilityTracker(element: Element): VisibilityTracker {
  const callbacks = new Set<(visible: boolean) => void>();

  // Initial state before the first observer callback: checkVisibility catches
  // display:none ancestors synchronously; default to visible where missing.
  let visible: boolean =
    typeof (element as HTMLElement).checkVisibility === 'function'
      ? (element as HTMLElement).checkVisibility()
      : true;

  let observer: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => {
        // Only the latest entry matters; entries are time-ordered.
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const next = entry.isIntersecting;
        if (next === visible) return;
        visible = next;
        for (const cb of callbacks) {
          try {
            cb(next);
          } catch (err) {
            // A broken subscriber must not stop visibility delivery to others.
            console.error('[editorVisibility] visibility callback threw:', err);
          }
        }
      },
      { threshold: 0 }
    );
    observer.observe(element);
  }

  return {
    getVisible: () => visible,
    subscribe(callback: (visible: boolean) => void): () => void {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    disconnect(): void {
      observer?.disconnect();
      observer = null;
      callbacks.clear();
    },
  };
}
