/**
 * inputRtl — automatically applies RTL to user input fields.
 *
 * When the user types in an RTL language, the input direction switches to rtl.
 * Targets input/textarea/contenteditable in the transcript composer.
 *
 * Strategy: an input event listener that detects direction from current content.
 */

import { detectDirection } from './detection';
import type { RtlSettings } from './settings';
import { debug } from './debug';

/**
 * Selectors for Nimbalyst composer input fields, combined into a single
 * comma-separated selector so each DOM mutation costs one matches() +
 * one querySelectorAll() rather than five. The observer watches document.body
 * (composers mount/unmount), so this fires on every app-wide mutation,
 * including token streaming — keeping the per-fire cost low matters.
 */
const INPUT_SELECTOR = [
  'textarea',
  'input[type="text"]',
  'input[type="search"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
].join(',');

/**
 * Selectors for the overlay elements that visually render the composer input.
 *
 * Since 0.68, the composer renders its visible text in a sibling overlay
 * (`.command-pill-overlay` / `.command-pill-overlay-text`) on top of a
 * transparent textarea, so @mention / @@session / /command tokens can be
 * highlighted. The textarea's own text is invisible, so setting `dir` only on
 * it leaves the visible overlay at LTR and RTL text appears on the left.
 */
const OVERLAY_SELECTOR = ['.command-pill-overlay', '.command-pill-overlay-text'].join(',');

let observer: MutationObserver | null = null;
let activeInputs: Set<HTMLElement> = new Set();
let currentSettings: RtlSettings | null = null;

/** Find the sibling overlays that mirror the input's visible text. */
function findOverlays(input: HTMLElement): HTMLElement[] {
  const root = input.closest('.ai-chat-input-textarea-wrap') || input.parentElement;
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)];
}

/** Apply the detected direction to the input and its visible-text overlays. */
function applyDirection(input: HTMLElement, dir: 'rtl' | 'ltr'): void {
  if (input.getAttribute('dir') !== dir) {
    input.setAttribute('dir', dir);
    debug('input direction changed to', dir);
  }
  for (const overlay of findOverlays(input)) {
    if (overlay.getAttribute('dir') !== dir) {
      overlay.setAttribute('dir', dir);
      debug('overlay direction changed to', dir);
    }
  }
}

function handleInput(e: Event): void {
  if (!currentSettings?.inputRtl) return;

  const target = e.target as HTMLElement;
  const text = getInputText(target);
  if (!text.trim()) return;

  const dir = detectDirection(text, currentSettings.threshold);
  applyDirection(target, dir);
}

function getInputText(el: HTMLElement): string {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    return (el as HTMLInputElement).value;
  }
  return el.textContent || '';
}

function attachInputListeners(el: HTMLElement): void {
  if (activeInputs.has(el)) return;
  activeInputs.add(el);
  el.addEventListener('input', handleInput, { passive: true });
  debug('attached input listener', el.tagName);
}

function detachInputListeners(el: HTMLElement): void {
  if (!activeInputs.has(el)) return;
  activeInputs.delete(el);
  el.removeEventListener('input', handleInput);
  debug('detached input listener', el.tagName);
}

function scanForInputs(root: HTMLElement): void {
  try {
    if (root.matches(INPUT_SELECTOR)) attachInputListeners(root);
    root.querySelectorAll<HTMLElement>(INPUT_SELECTOR).forEach(attachInputListeners);
  } catch {
    // ignore bad selector
  }
}

/**
 * Drop input listeners for a removed subtree. Without this, an input that is
 * unmounted and recreated mid-session (e.g. the composer remounting) stays in
 * activeInputs as a strong reference with its listener bound until deactivate.
 */
function detachRemovedInputs(removed: HTMLElement): void {
  for (const el of activeInputs) {
    if (removed === el || removed.contains(el)) {
      detachInputListeners(el);
    }
  }
}

/**
 * Start applying RTL to input fields.
 */
export function startInputRtl(root: HTMLElement, settings: RtlSettings): void {
  // Guard against a double-activate orphaning the previous observer/listeners.
  stopInputRtl();

  currentSettings = settings;
  if (!settings.enabled || !settings.inputRtl) {
    debug('input RTL disabled');
    return;
  }

  // Initial scan
  scanForInputs(root);

  // Watch for inputs mounting/unmounting (e.g. when the composer remounts)
  observer = new MutationObserver((mutations) => {
    if (!currentSettings?.inputRtl) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scanForInputs(node as HTMLElement);
        }
      }
      for (const node of mutation.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          detachRemovedInputs(node as HTMLElement);
        }
      }
    }
  });

  observer.observe(root, { childList: true, subtree: true });
  debug('input RTL started');
}

/** Stop and clean up */
export function stopInputRtl(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  for (const el of activeInputs) {
    el.removeEventListener('input', handleInput);
  }
  activeInputs.clear();
  currentSettings = null;
  debug('input RTL stopped');
}
