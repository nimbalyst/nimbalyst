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

/** Selectors for Nimbalyst composer input fields */
const INPUT_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'input[type="search"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
];

let observer: MutationObserver | null = null;
let activeInputs: Set<HTMLElement> = new Set();
let currentSettings: RtlSettings | null = null;

function handleInput(e: Event): void {
  if (!currentSettings?.inputRtl) return;

  const target = e.target as HTMLElement;
  const text = getInputText(target);
  if (!text.trim()) return;

  const dir = detectDirection(text, currentSettings.threshold);
  if (target.getAttribute('dir') !== dir) {
    target.setAttribute('dir', dir);
    debug('input direction changed to', dir);
  }
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

function scanForInputs(root: HTMLElement): void {
  for (const selector of INPUT_SELECTORS) {
    try {
      if (root.matches(selector)) attachInputListeners(root);
      root.querySelectorAll<HTMLElement>(selector).forEach(attachInputListeners);
    } catch {
      // ignore bad selector
    }
  }
}

/**
 * Start applying RTL to input fields.
 */
export function startInputRtl(root: HTMLElement, settings: RtlSettings): void {
  currentSettings = settings;
  if (!settings.enabled || !settings.inputRtl) {
    debug('input RTL disabled');
    return;
  }

  // Initial scan
  scanForInputs(root);

  // Watch for new inputs (e.g. when composer mounts)
  observer = new MutationObserver((mutations) => {
    if (!currentSettings?.inputRtl) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          scanForInputs(node as HTMLElement);
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
