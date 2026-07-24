/**
 * Transcript markdown contribution registry.
 *
 * Extensions register remark/rehype plugin chains, component overrides, and
 * stylesheet metadata that the transcript's `MarkdownRenderer` should layer on
 * top of its core baseline. Each contributor identifies itself with a stable
 * `source` string (typically the extension id) so it can later overwrite or
 * clear its own registration without disturbing other contributors.
 *
 * The store is plain module state -- the runtime already exposes other plugin
 * registries this way (see `extensions/ExtensionLoader`) and the transcript UI
 * mounts in a single React tree per workspace, so per-renderer isolation is
 * not needed.
 */

import type { ComponentType } from 'react';

/**
 * Styles a transcript markdown contributor injects into the document.
 *
 * `css-text` is inserted via a `<style>` tag scoped by `id`; `stylesheet`
 * inserts a `<link rel="stylesheet">`. Both are managed by the host so the
 * tags are added at most once per `id` and removed when the contributor
 * clears its registration.
 */
export type TranscriptMarkdownContributedStyle =
  | { type: 'css-text'; id: string; cssText: string }
  | { type: 'stylesheet'; id: string; href: string };

/**
 * A single transcript markdown contribution.
 *
 * All fields are optional so a contributor can ship just plugins, just
 * components, just styles, or any combination.
 *
 * `remarkPlugins` and `rehypePlugins` are passed straight to
 * `react-markdown` via the host's merged plugin lists, so the entries follow
 * the same shape react-markdown accepts (plugin function or `[plugin,
 * options]` tuple). They are typed as `unknown` here to avoid pinning a
 * unified/react-markdown version in the public API.
 *
 * `components` is merged into react-markdown's `components` map after the
 * host's built-in overrides; last contributor wins on conflicts.
 */
export interface TranscriptMarkdownContribution {
  remarkPlugins?: ReadonlyArray<unknown>;
  rehypePlugins?: ReadonlyArray<unknown>;
  components?: Readonly<Record<string, ComponentType<any>>>;
  styles?: ReadonlyArray<TranscriptMarkdownContributedStyle>;
}

/**
 * Merged view of every active markdown contribution.
 *
 * `MarkdownRenderer` consumes this directly; ordering is deterministic
 * (insertion order of `setTranscriptMarkdownContributions` calls per source).
 */
export interface MergedTranscriptMarkdownContribution {
  remarkPlugins: ReadonlyArray<unknown>;
  rehypePlugins: ReadonlyArray<unknown>;
  components: Readonly<Record<string, ComponentType<any>>>;
  styles: ReadonlyArray<TranscriptMarkdownContributedStyle>;
}

const EMPTY_MERGED: MergedTranscriptMarkdownContribution = Object.freeze({
  remarkPlugins: Object.freeze([]) as ReadonlyArray<unknown>,
  rehypePlugins: Object.freeze([]) as ReadonlyArray<unknown>,
  components: Object.freeze({}) as Readonly<Record<string, ComponentType<any>>>,
  styles: Object.freeze([]) as ReadonlyArray<TranscriptMarkdownContributedStyle>,
});

const contributions = new Map<string, TranscriptMarkdownContribution>();
const listeners = new Set<() => void>();

let cachedMerged: MergedTranscriptMarkdownContribution | null = EMPTY_MERGED;

function notifyListeners(): void {
  // Snapshot first; listeners may unsubscribe during dispatch.
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.error('[TranscriptMarkdownContributions] listener threw', error);
    }
  }
}

function invalidateCache(): void {
  cachedMerged = null;
}

/**
 * Register (or replace) a markdown contribution for a given source.
 *
 * Passing `undefined` is equivalent to `clearTranscriptMarkdownContributions`.
 */
export function setTranscriptMarkdownContributions(
  source: string,
  next?: TranscriptMarkdownContribution,
): void {
  if (!source) {
    throw new Error('setTranscriptMarkdownContributions requires a non-empty source');
  }
  if (!next) {
    clearTranscriptMarkdownContributions(source);
    return;
  }
  contributions.set(source, next);
  invalidateCache();
  notifyListeners();
}

/**
 * Remove a previously registered markdown contribution.
 *
 * Calling with an unknown source is a no-op (and does not notify subscribers).
 */
export function clearTranscriptMarkdownContributions(source: string): void {
  if (!contributions.has(source)) {
    return;
  }
  contributions.delete(source);
  invalidateCache();
  notifyListeners();
}

/**
 * Get the merged contribution view that `MarkdownRenderer` should consume.
 *
 * The result is memoized; consecutive calls return the same reference until
 * a `set`/`clear` invalidates it. That makes it safe to depend on directly
 * inside React's `useMemo`.
 */
export function getMergedTranscriptMarkdownContributions(): MergedTranscriptMarkdownContribution {
  if (cachedMerged) {
    return cachedMerged;
  }
  if (contributions.size === 0) {
    cachedMerged = EMPTY_MERGED;
    return cachedMerged;
  }
  const remarkPlugins: unknown[] = [];
  const rehypePlugins: unknown[] = [];
  const components: Record<string, ComponentType<any>> = {};
  const styles: TranscriptMarkdownContributedStyle[] = [];
  for (const contribution of contributions.values()) {
    if (contribution.remarkPlugins) {
      remarkPlugins.push(...contribution.remarkPlugins);
    }
    if (contribution.rehypePlugins) {
      rehypePlugins.push(...contribution.rehypePlugins);
    }
    if (contribution.components) {
      for (const [name, component] of Object.entries(contribution.components)) {
        components[name] = component;
      }
    }
    if (contribution.styles) {
      styles.push(...contribution.styles);
    }
  }
  cachedMerged = {
    remarkPlugins,
    rehypePlugins,
    components,
    styles,
  };
  return cachedMerged;
}

/**
 * Subscribe to contribution changes.
 *
 * Returns an unsubscribe function. Listeners are invoked synchronously after
 * each `set`/`clear`; React consumers should pair this with `useSyncExternal-
 * Store` or a `useEffect` that re-reads the merged view.
 */
export function subscribeToTranscriptMarkdownContributions(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Test helper. Drops every contribution and resets the merge cache. Not
 * exported from the package public surface; tests reach in via the file path.
 */
export function _resetTranscriptMarkdownContributionsForTests(): void {
  contributions.clear();
  cachedMerged = EMPTY_MERGED;
  notifyListeners();
}
