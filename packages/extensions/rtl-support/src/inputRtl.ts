/**
 * inputRtl — اعمال خودکار RTL روی فیلدهای ورودی کاربر.
 *
 * وقتی کاربر فارسی تایپ می‌کنه، direction input به rtl تغییر می‌کنه.
 * برای input/textarea/contenteditable در transcript composer.
 *
 * استراتژی: input event listener که جهت رو بر اساس محتوای فعلی تشخیص می‌ده.
 */

import { detectDirection } from './detection';
import type { RtlSettings } from './settings';
import { debug } from './debug';

/** selector‌های فیلد ورودی composer Nimbalyst */
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
    debug('input direction →', dir);
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
      // اول خود element
      if (root.matches(selector)) attachInputListeners(root);
      // بعد children
      root.querySelectorAll<HTMLElement>(selector).forEach(attachInputListeners);
    } catch {
      // ignore bad selector
    }
  }
}

/**
 * شروع اعمال RTL روی فیلدهای ورودی.
 */
export function startInputRtl(root: HTMLElement, settings: RtlSettings): void {
  currentSettings = settings;
  if (!settings.enabled || !settings.inputRtl) {
    debug('input RTL disabled');
    return;
  }

  // اسکن اولیه
  scanForInputs(root);

  // watch برای input‌های جدید (مثلاً وقتی composer mount می‌شه)
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

/** توقف و پاک‌سازی */
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
