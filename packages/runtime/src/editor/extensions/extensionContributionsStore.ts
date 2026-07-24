/**
 * In-process registry of Nimbalyst-side editor contributions that aren't
 * expressible through `LexicalExtension` alone -- specifically the
 * component-picker surface (`userCommands`, `getDynamicOptions`) and the
 * live list of markdown transformers consumed by import/export.
 *
 * Built-in extensions (Mermaid, Images, Kanban, etc.) publish into this
 * store at module-load time when their extension files are imported by
 * `NimbalystEditorExtensions.ts`. Extension-loader contributions land here
 * via the renderer's extension bridge.
 *
 * Replaces the legacy `PluginRegistry` for the parts that aren't already
 * covered by `LexicalExtension.nodes`, `register`, and `dependencies`.
 */

import { useSyncExternalStore } from 'react';
import type { Transformer } from '@lexical/markdown';

import type {
  DynamicMenuOption,
  UserCommand,
} from '../types/PluginTypes';

export interface EditorExtensionContributions {
  /** Component-picker entries this contributor exposes. */
  userCommands?: ReadonlyArray<UserCommand>;
  /** Markdown transformers contributed by this source. */
  markdownTransformers?: ReadonlyArray<Transformer>;
  /** Async provider for dynamic component-picker options. */
  getDynamicOptions?: (
    queryString: string,
  ) => DynamicMenuOption[] | Promise<DynamicMenuOption[]>;
}

const contributions = new Map<string, EditorExtensionContributions>();
const listeners = new Set<() => void>();

let userCommandsCache: ReadonlyArray<UserCommand> = Object.freeze([]);
let transformersCache: ReadonlyArray<Transformer> = Object.freeze([]);

function rebuildCaches(): void {
  const userCommandsAcc: UserCommand[] = [];
  const transformersAcc: Transformer[] = [];
  for (const c of contributions.values()) {
    if (c.userCommands) userCommandsAcc.push(...c.userCommands);
    if (c.markdownTransformers) transformersAcc.push(...c.markdownTransformers);
  }
  userCommandsCache = Object.freeze(userCommandsAcc);
  transformersCache = Object.freeze(transformersAcc);
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[extensionContributionsStore] listener threw', err);
    }
  }
}

/**
 * Publish (or replace) the contributions associated with a named source.
 * Pass `undefined` to clear -- equivalent to
 * `clearExtensionContributions`.
 */
export function setExtensionContributions(
  name: string,
  next: EditorExtensionContributions | undefined,
): void {
  if (next === undefined) {
    if (!contributions.has(name)) return;
    contributions.delete(name);
  } else {
    contributions.set(name, next);
  }
  rebuildCaches();
  emit();
}

export function clearExtensionContributions(name: string): void {
  setExtensionContributions(name, undefined);
}

export function getAllExtensionUserCommands(): ReadonlyArray<UserCommand> {
  return userCommandsCache;
}

export function getAllExtensionTransformers(): ReadonlyArray<Transformer> {
  return transformersCache;
}

/**
 * Collect dynamic component-picker options from every contributor that
 * declared a provider. Each provider's result is awaited independently;
 * errors are logged and skipped so a misbehaving extension can't take
 * down the picker.
 */
export async function getAllExtensionDynamicOptions(
  queryString: string,
): Promise<DynamicMenuOption[]> {
  const collected: DynamicMenuOption[] = [];
  for (const [name, c] of contributions) {
    if (!c.getDynamicOptions) continue;
    try {
      const options = await c.getDynamicOptions(queryString);
      collected.push(...options);
    } catch (error) {
      console.error(
        `[extensionContributionsStore] dynamic options from "${name}" threw`,
        error,
      );
    }
  }
  return collected;
}

export function subscribeToExtensionContributions(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribe to the user-command list. The snapshot reference changes
 * whenever any contributor's user commands change.
 */
export function useExtensionUserCommands(): ReadonlyArray<UserCommand> {
  return useSyncExternalStore(
    subscribeToExtensionContributions,
    getAllExtensionUserCommands,
    getAllExtensionUserCommands,
  );
}
