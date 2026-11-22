/**
 * Registry of surfaces that accept dictated text.
 *
 * The agent input registers itself; document editors register through
 * `EditorHost.registerDictationTarget` (createEditorHost forwards here). The
 * controller asks for the focused target when the shortcut fires, or for a
 * specific key when the mic button is clicked.
 */

import type { DictationTarget } from '@nimbalyst/runtime/extensions/editorHost';
import type { DictationSurface } from '../store/atoms/dictation';

export interface RegisteredDictationTarget extends DictationTarget {
  key: string;
  surface: DictationSurface;
}

const targets = new Map<string, RegisteredDictationTarget>();

export function registerDictationTarget(target: RegisteredDictationTarget): () => void {
  targets.set(target.key, target);
  return () => {
    if (targets.get(target.key) === target) targets.delete(target.key);
  };
}

export function getDictationTarget(key: string): RegisteredDictationTarget | undefined {
  return targets.get(key);
}

export function findFocusedDictationTarget(): RegisteredDictationTarget | undefined {
  for (const target of targets.values()) {
    try {
      if (target.hasFocus()) return target;
    } catch {
      // A target whose editor was torn down mid-check is simply not focused.
    }
  }
  return undefined;
}

/**
 * Adapter for EditorHost.registerDictationTarget: one slot per host, replaced
 * on each call, cleared with null.
 */
export function createHostDictationSlot(hostKey: string): (target: DictationTarget | null) => void {
  let unregister: (() => void) | null = null;
  return (target) => {
    unregister?.();
    unregister = null;
    if (target) {
      unregister = registerDictationTarget({
        key: hostKey,
        surface: target.kind === 'code' ? 'code' : 'markdown',
        kind: target.kind,
        hasFocus: () => target.hasFocus(),
        showPartial: target.showPartial?.bind(target),
        getCaretRect: target.getCaretRect?.bind(target),
        clearPartial: () => target.clearPartial(),
        commitFinal: (text) => target.commitFinal(text),
      });
    }
  };
}
