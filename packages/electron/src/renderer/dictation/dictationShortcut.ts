/**
 * Dictation keyboard shortcut: Ctrl+Option+Space (Ctrl+Alt+Space off macOS).
 *
 * Hold to talk, release to stop. A quick tap (shorter than HOLD_THRESHOLD_MS)
 * leaves dictation running until the next tap, for longer passages. Esc while
 * dictating cancels and discards the pending partial; it is consumed so it
 * does not also cancel a running agent turn.
 *
 * Chosen because nothing in the app, Monaco, or Lexical binds it, and neither
 * macOS nor Windows does by default (Cmd+Shift+Space is Monaco's parameter
 * hints; Ctrl+Space and Cmd+Space are OS input source / Spotlight).
 *
 * When dictation is disabled the key is not consumed at all.
 */

import { KeyboardShortcuts } from '../../shared/KeyboardShortcuts';
import type { DictationController } from './dictationController';

export const DICTATION_SHORTCUT = KeyboardShortcuts.dictation.holdToTalk;

const HOLD_THRESHOLD_MS = 350;

export function isDictationShortcut(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>,
): boolean {
  return e.code === 'Space' && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey;
}

export function installDictationShortcut(
  getController: () => DictationController,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  now: () => number = () => Date.now(),
): () => void {
  let pressedAt: number | null = null;
  let systemPending = false;

  const onKeyDown = (e: KeyboardEvent) => {
    const controller = getController();
    if (e.key === 'Escape' && controller.isRecording()) {
      e.preventDefault();
      e.stopPropagation();
      pressedAt = null;
      controller.stop(true);
      return;
    }
    if (!isDictationShortcut(e) || !controller.isEnabled()) return;
    e.preventDefault();
    e.stopPropagation();
    if (controller.usesSystemDictation()) {
      // macOS dictation stalls if started while keys are held; wait for release.
      systemPending = true;
      return;
    }
    if (e.repeat || pressedAt !== null) return;
    if (controller.isRecording()) {
      // Second tap of tap-to-toggle.
      controller.stop(false);
      return;
    }
    pressedAt = now();
    void controller.startInFocused('shortcut').then((started) => {
      if (!started) pressedAt = null;
    });
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (systemPending) {
      if (e.ctrlKey || e.altKey) return;
      systemPending = false;
      void getController().startInFocused('shortcut');
      return;
    }
    if (pressedAt === null) return;
    if (e.code !== 'Space' && e.key !== 'Control' && e.key !== 'Alt') return;
    const heldFor = now() - pressedAt;
    pressedAt = null;
    if (heldFor >= HOLD_THRESHOLD_MS) getController().stop(false);
  };

  // Releasing the keys while the window is in the background never fires keyup.
  const onBlur = () => {
    systemPending = false;
    if (pressedAt === null) return;
    pressedAt = null;
    getController().stop(false);
  };

  target.addEventListener('keydown', onKeyDown as EventListener, true);
  target.addEventListener('keyup', onKeyUp as EventListener, true);
  target.addEventListener('blur', onBlur);
  return () => {
    target.removeEventListener('keydown', onKeyDown as EventListener, true);
    target.removeEventListener('keyup', onKeyUp as EventListener, true);
    target.removeEventListener('blur', onBlur);
  };
}
