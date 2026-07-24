/**
 * Extension Input Guard
 *
 * Monkey-patches window.addEventListener so that any keydown handler
 * registered on `window` is automatically wrapped with a text-input guard.
 *
 * When focus is in a text input (input, textarea, contentEditable) and the
 * key is a printable/typing character (letters, digits, space, symbols) with
 * no modifier key, the handler is silently skipped. Navigation keys (Escape,
 * arrows, Tab, Enter, F-keys) always pass through so host dialogs (QuickOpen,
 * etc.) can handle them even when their search input has focus.
 *
 * The patch must be installed BEFORE any extensions load. Import this
 * module as a side-effect at the top of the app entry point.
 *
 * Modified-key combos (Cmd+E, Ctrl+`, etc.) always pass through so host
 * keyboard shortcuts keep working.
 */

function isTextInput(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    // Only guard text-like inputs, not buttons/checkboxes/radios
    return !type || type === 'text' || type === 'search' || type === 'url'
      || type === 'email' || type === 'password' || type === 'number'
      || type === 'tel';
  }
  if (tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Keys that should NEVER be guarded — they are navigation/control keys
 * that host components legitimately handle via window-level listeners
 * even when an input has focus (e.g., QuickOpen uses Escape to close
 * and arrows to navigate the list).
 */
const PASSTHROUGH_KEYS = new Set([
  'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Tab',
  'Enter',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function shouldGuard(e: KeyboardEvent): boolean {
  // Let modified keys through — host shortcuts use Cmd/Ctrl
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  // Let navigation/control keys through — host dialogs need Escape, arrows, etc.
  if (PASSTHROUGH_KEYS.has(e.key)) return false;
  // Only guard printable/typing keys when focus is in a text input
  return isTextInput(document.activeElement);
}

// ---- Monkey-patch window.addEventListener / removeEventListener ----

const originalAdd = window.addEventListener.bind(window);
const originalRemove = window.removeEventListener.bind(window);

// Map original handlers to their wrapped versions so removeEventListener works
const wrapperMap = new WeakMap<EventListenerOrEventListenerObject, EventListenerOrEventListenerObject>();

window.addEventListener = function (
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
): void {
  if (listener && (type === 'keydown' || type === 'keyup' || type === 'keypress')) {
    const wrapped: EventListener = (e: Event) => {
      if (shouldGuard(e as KeyboardEvent)) return;
      if (typeof listener === 'function') {
        listener.call(window, e);
      } else {
        listener.handleEvent(e);
      }
    };
    wrapperMap.set(listener, wrapped);
    return originalAdd(type, wrapped, options);
  }
  return originalAdd(type, listener!, options);
} as typeof window.addEventListener;

window.removeEventListener = function (
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | EventListenerOptions,
): void {
  if (listener && (type === 'keydown' || type === 'keyup' || type === 'keypress')) {
    const wrapped = wrapperMap.get(listener);
    if (wrapped) {
      wrapperMap.delete(listener);
      return originalRemove(type, wrapped, options);
    }
  }
  return originalRemove(type, listener!, options);
} as typeof window.removeEventListener;
