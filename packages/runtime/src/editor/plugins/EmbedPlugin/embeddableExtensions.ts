/**
 * Registry of file extensions whose paragraph-isolated links should
 * auto-upgrade into `EmbeddedFileNode`s.
 *
 * Starts empty. The host (in Electron, the renderer's
 * `registerEmbedFrame`) populates this from `customEditorRegistry` at
 * startup and re-syncs whenever extensions register / unregister, so the
 * set of embeddable types is whatever extensions are actually installed.
 * Phase 2 will add a manifest opt-in (`embeddable: true` on the custom
 * editor contribution) so extensions can declare "I render in-tab but I
 * shouldn't be inline-embeddable". Until then, anything with a registered
 * custom editor is treated as embeddable.
 *
 * Keep extensions lowercase with a leading dot. Compound extensions
 * (e.g. `.mockup.html`) are fine; matching is by lowercased suffix.
 */

const embeddable = new Set<string>();
const changeListeners = new Set<() => void>();

function normalize(ext: string): string {
  const lower = ext.toLowerCase();
  return lower.startsWith('.') ? lower : `.${lower}`;
}

function notifyChange(): void {
  for (const cb of changeListeners) {
    try {
      cb();
    } catch (err) {
      // Listener crashes shouldn't take other listeners down -- log and
      // continue. (Don't import the runtime logger here; this module runs
      // in mobile too.)
      console.error('[embeddableExtensions] listener crashed', err);
    }
  }
}

export function getEmbeddableExtensions(): readonly string[] {
  return Array.from(embeddable);
}

export function isEmbeddableUrl(url: string, embedType?: string): boolean {
  if (!url) return false;
  const isCollabReference = /^nimbalyst:\/\/doc\//i.test(url);
  // Collaborative references intentionally have no file suffix in the URL.
  // They are embeddable only when Share to Team preserved a registered type
  // hint in the CommonMark title attributes.
  if (isCollabReference) {
    if (!embedType) return false;
    return embeddable.has(normalize(embedType));
  }
  // Bare URLs (http/https/mailto/etc.) never upgrade; only filesystem paths.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) return false;
  const lower = url.toLowerCase();
  // Strip any query/fragment before matching the suffix.
  const pathPart = lower.split('?')[0].split('#')[0];
  for (const ext of embeddable) {
    if (pathPart.endsWith(ext)) return true;
  }
  return false;
}

export function registerEmbeddableExtension(ext: string): void {
  const next = normalize(ext);
  if (embeddable.has(next)) return;
  embeddable.add(next);
  notifyChange();
}

export function unregisterEmbeddableExtension(ext: string): void {
  const target = normalize(ext);
  if (!embeddable.has(target)) return;
  embeddable.delete(target);
  notifyChange();
}

/** Replace the entire set in one shot. Used by host-side sync from a registry. */
export function setEmbeddableExtensions(extensions: Iterable<string>): void {
  const next = new Set<string>();
  for (const ext of extensions) next.add(normalize(ext));

  // No-op when the set is unchanged so we don't trigger gratuitous editor
  // re-scans (host registries fire `onChange` whenever any custom-editor
  // bookkeeping changes, not just when our subset changes).
  if (next.size === embeddable.size) {
    let same = true;
    for (const ext of next) {
      if (!embeddable.has(ext)) { same = false; break; }
    }
    if (same) return;
  }

  embeddable.clear();
  for (const ext of next) embeddable.add(ext);
  notifyChange();
}

/**
 * Subscribe to changes in the embeddable set. The Lexical `EmbedExtension`
 * uses this to retroactively walk imported `LinkNode`s and upgrade any that
 * have become eligible since they were created -- needed because extensions
 * typically register their file types AFTER the host markdown doc has
 * already loaded.
 */
export function subscribeToEmbeddableExtensionsChanges(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}
