/**
 * useExtensionKeybindings
 *
 * Reads keybinding contributions from all loaded extension manifests,
 * registers them in ExtensionCommandRegistry, and fires the matching
 * command when the key combo is pressed.
 *
 * This hook mounts a single capture-phase keydown listener.
 * It re-syncs registered keybindings whenever extensions load/unload.
 */

import { useEffect } from 'react';
import { getExtensionLoader } from '@nimbalyst/runtime';
import {
  registerKeybinding,
  executeCommand,
  unregisterExtension,
  getRegisteredKeybindings,
} from './ExtensionCommandRegistry';

// ============================================================================
// Key parsing
// ============================================================================

interface ParsedKey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  cmd: boolean;
  key: string; // lowercase key name, e.g. "g", "backquote"
}

/**
 * Parse a manifest key string like "ctrl+shift+g" into structured flags.
 * Modifiers: ctrl, shift, alt, cmd (cmd = metaKey on Mac, ctrlKey on Windows/Linux)
 */
function parseManifestKey(keyString: string): ParsedKey {
  const parts = keyString.toLowerCase().split('+');
  const parsed: ParsedKey = { ctrl: false, shift: false, alt: false, cmd: false, key: '' };

  for (const part of parts) {
    if (part === 'ctrl') parsed.ctrl = true;
    else if (part === 'shift') parsed.shift = true;
    else if (part === 'alt') parsed.alt = true;
    else if (part === 'cmd') parsed.cmd = true;
    else parsed.key = part;
  }

  return parsed;
}

const IS_MAC = navigator.platform.startsWith('Mac');

/**
 * Returns true if the keyboard event matches the parsed key.
 */
function eventMatchesKey(e: KeyboardEvent, parsed: ParsedKey): boolean {
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;

  if (parsed.cmd) {
    // "cmd" means metaKey on Mac, ctrlKey elsewhere
    const cmdPressed = IS_MAC ? e.metaKey : e.ctrlKey;
    if (!cmdPressed) return false;
    // ctrl must NOT also be pressed when using cmd (to avoid double-matching)
    if (IS_MAC && e.ctrlKey) return false;
  }

  if (parsed.ctrl) {
    if (!e.ctrlKey) return false;
    // On Mac with cmd modifier, ctrl would be checked separately above
  }

  // Normalize e.key to match manifest key strings
  const eventKey = normalizeEventKey(e);
  return eventKey === parsed.key;
}

function normalizeEventKey(e: KeyboardEvent): string {
  const k = e.key;
  if (k === ' ') return 'space';
  if (k === '`') return 'backquote';
  // When shift is held, e.key is the shifted character (e.g., 'G' not 'g')
  return k.toLowerCase();
}

// ============================================================================
// Registration sync
// ============================================================================

// Track which extension IDs we've already registered keybindings for,
// so we don't double-register on re-syncs without an actual change.
const registeredExtensionIds = new Set<string>();

function syncKeybindings(): void {
  const loader = getExtensionLoader();
  const extensions = loader.getLoadedExtensions();
  const currentIds = new Set(extensions.map(e => e.manifest.id));

  // Unregister keybindings for extensions that have been removed
  for (const id of registeredExtensionIds) {
    if (!currentIds.has(id)) {
      unregisterExtension(id);
      registeredExtensionIds.delete(id);
    }
  }

  // Register keybindings for newly loaded extensions
  for (const ext of extensions) {
    if (registeredExtensionIds.has(ext.manifest.id)) continue;

    const keybindings = ext.manifest.contributions?.keybindings;
    if (!keybindings?.length) continue;

    for (const kb of keybindings) {
      if (!kb.key || !kb.command) {
        console.warn(
          `[useExtensionKeybindings] Skipping invalid keybinding in ${ext.manifest.id}:`,
          kb
        );
        continue;
      }
      registerKeybinding(kb.key, kb.command, ext.manifest.id);
    }

    registeredExtensionIds.add(ext.manifest.id);
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useExtensionKeybindings(): void {
  // Sync keybindings whenever extensions change
  useEffect(() => {
    const loader = getExtensionLoader();

    syncKeybindings();
    const unsubscribe = loader.subscribe(() => syncKeybindings());

    return unsubscribe;
  }, []);

  // Listen for key combos
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const keybindings = getRegisteredKeybindings();
      for (const kb of keybindings) {
        const parsed = parseManifestKey(kb.key);
        if (eventMatchesKey(e, parsed)) {
          e.preventDefault();
          e.stopPropagation();
          executeCommand(kb.commandId);
          return; // Only fire the first match
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);
}
