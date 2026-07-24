/**
 * Transcript tool widget contribution registry.
 *
 * `RichTranscriptView` consults this registry before falling back to its
 * generic tool-call card. Built-in widgets register here at module load and
 * extension-contributed widgets register through `setTranscriptToolWidgets`.
 *
 * Resolution honors:
 *  - the contributor's registration order (later contributors win on
 *    duplicate tool names, after a console warning so we notice during dev);
 *  - the MCP prefix stripping rules used by the legacy `CUSTOM_TOOL_WIDGETS`
 *    constant, so `mcp__server__tool_name` lookups still resolve to a
 *    bare `tool_name` registration.
 */

import type { CustomToolWidgetComponent } from '../components/CustomToolWidgets';

export type TranscriptToolWidgetRegistry = Readonly<
  Record<string, CustomToolWidgetComponent>
>;

interface WidgetRecord {
  source: string;
  toolName: string;
  component: CustomToolWidgetComponent;
}

// Sources are stored insertion-ordered (Map preserves insertion order);
// resolution walks newer-to-older so the latest contributor wins on
// duplicates, matching the precedence note in the design plan.
const contributionsBySource = new Map<string, TranscriptToolWidgetRegistry>();
const listeners = new Set<() => void>();

let cachedResolution: ReadonlyMap<string, WidgetRecord> | null = null;
let cachedToolNames: readonly string[] | null = null;

function notifyListeners(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      console.error('[TranscriptToolWidgetContributions] listener threw', error);
    }
  }
}

function buildResolution(): ReadonlyMap<string, WidgetRecord> {
  const merged = new Map<string, WidgetRecord>();
  for (const [source, registry] of contributionsBySource) {
    for (const [toolName, component] of Object.entries(registry)) {
      const existing = merged.get(toolName);
      if (existing && existing.source !== source) {
        console.warn(
          `[TranscriptToolWidgetContributions] '${toolName}' registered by ` +
            `'${existing.source}' is being overridden by '${source}'.`,
        );
      }
      merged.set(toolName, { source, toolName, component });
    }
  }
  return merged;
}

function getResolution(): ReadonlyMap<string, WidgetRecord> {
  if (!cachedResolution) {
    cachedResolution = buildResolution();
  }
  return cachedResolution;
}

function invalidateCache(): void {
  cachedResolution = null;
  cachedToolNames = null;
}

/**
 * Replace the entire widget mapping contributed by a given source.
 *
 * Passing `undefined` is equivalent to `clearTranscriptToolWidgets`.
 */
export function setTranscriptToolWidgets(
  source: string,
  next?: TranscriptToolWidgetRegistry,
): void {
  if (!source) {
    throw new Error('setTranscriptToolWidgets requires a non-empty source');
  }
  if (!next) {
    clearTranscriptToolWidgets(source);
    return;
  }
  contributionsBySource.set(source, next);
  invalidateCache();
  notifyListeners();
}

/**
 * Remove all widgets contributed by a given source. No-op for unknown sources.
 */
export function clearTranscriptToolWidgets(source: string): void {
  if (!contributionsBySource.has(source)) {
    return;
  }
  contributionsBySource.delete(source);
  invalidateCache();
  notifyListeners();
}

/**
 * Resolve a tool name against the merged registry.
 *
 * Matches the lookup rules previously used by
 * `CUSTOM_TOOL_WIDGETS`/`getCustomToolWidget`:
 *  1. Exact match.
 *  2. Strip the `mcp__nimbalyst__` prefix.
 *  3. Strip any `mcp__<server>__` prefix.
 *
 * Shell-wrapper fallback (matching `Bash`/`zsh -c '...'` strings) is *not*
 * implemented here; that logic still lives in
 * `CustomToolWidgets/index.ts:getCustomToolWidget` so it stays adjacent to
 * the regex it depends on.
 */
export function getTranscriptToolWidget(
  toolName: string,
): CustomToolWidgetComponent | undefined {
  if (!toolName) return undefined;
  const resolution = getResolution();
  const direct = resolution.get(toolName);
  if (direct) return direct.component;

  const withoutNimbalystPrefix = toolName.replace(/^mcp__nimbalyst__/, '');
  if (withoutNimbalystPrefix !== toolName) {
    const nimbalystMatch = resolution.get(withoutNimbalystPrefix);
    if (nimbalystMatch) return nimbalystMatch.component;
  }

  const withoutAnyMcpPrefix = toolName.replace(/^mcp__[^_]+__/, '');
  if (withoutAnyMcpPrefix !== toolName) {
    const mcpMatch = resolution.get(withoutAnyMcpPrefix);
    if (mcpMatch) return mcpMatch.component;
  }
  return undefined;
}

/**
 * Subscribe to widget registry changes. Returns an unsubscribe function.
 */
export function subscribeToTranscriptToolWidgets(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Snapshot of every registered tool name. Memoized so callers (notably
 * `useSyncExternalStore` in `useTranscriptToolWidgetRegistryVersion`) get a
 * stable reference between mutations -- without this, the hook's
 * getSnapshot would hand React a fresh array each call and trigger a
 * Maximum-update-depth loop.
 */
export function getRegisteredTranscriptToolNames(): readonly string[] {
  if (!cachedToolNames) {
    cachedToolNames = Object.freeze(Array.from(getResolution().keys()));
  }
  return cachedToolNames;
}

/**
 * Test helper -- drops every contribution. Not exported from the package
 * public surface.
 */
export function _resetTranscriptToolWidgetsForTests(): void {
  contributionsBySource.clear();
  cachedResolution = null;
  cachedToolNames = null;
  notifyListeners();
}
