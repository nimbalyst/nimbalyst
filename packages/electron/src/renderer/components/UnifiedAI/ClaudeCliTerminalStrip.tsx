import React, { useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { TerminalPanel } from '../Terminal/TerminalPanel';
import { windowFocusedAtom } from '../../store/atoms/windowFocus';

export interface ClaudeCliTerminalStripProps {
  sessionId: string;
  workspacePath: string;
  /** Combined (`claude-code-cli:opus-1m`) or bare model id; resolved to the CLI alias in main. */
  model?: string;
  /** Bumped by the reveal listener (NIM-810) to focus the xterm for a native picker. */
  focusNonce?: number;
  /**
   * Element to observe for on-screen visibility instead of this strip's own
   * container (NIM-812). Callers pass the always-rendered drawer root so the CLI
   * still spawns while the drawer is collapsed ("spawn hidden, stay collapsed").
   * The strip body itself is `display:none` when collapsed, which would never
   * intersect; the drawer header is always laid out, so observing it is correct.
   */
  observeRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Hosts the genuine `claude` CLI terminal for a `claude-code-cli` session
 * (NIM-806, Phase 1).
 *
 * The CLI is launched ONLY once this strip is actually on-screen. Nimbalyst keeps
 * all mode components mounted and toggles them with CSS `display`, so a
 * `claude-code-cli` session that is merely the *active* agent session while the
 * agent panel is hidden (after restart, or while the user is in editor mode) must
 * NOT auto-launch the CLI in the background — that would silently spin up a real
 * `claude` process on the user's subscription with no window showing it.
 *
 * Launch is gated on TWO signals, both required:
 *   1. The strip (or caller-provided drawer root) is on-screen, via an
 *      IntersectionObserver.
 *   2. This window is the OS-focused (key) window, via `windowFocusedAtom` —
 *      the main process's per-window focus state.
 *
 * IntersectionObserver alone reports "visible" for any window whose DOM is laid
 * out, even one sitting in the background. On restart, every restored window has
 * its agent panel open with a `claude-code-cli` session active, so gating on
 * intersection alone spawned the genuine CLI in ALL windows at once. The CLI
 * fires an upstream request just from being launched, so the simultaneous spawns
 * stampeded the subscription rate/concurrency cap and every turn failed
 * ("The Claude CLI turn failed.", NIM-813).
 *
 * The focus gate originally used `document.hasFocus()`, but that is true for
 * EVERY window while the app is the active application — it cannot distinguish a
 * background window from the foreground one, so an app-activation pulse re-spawned
 * every background session at once and re-created the stampede (NIM-849). We now
 * gate on `windowFocusedAtom`, fed by main's per-window `browser-window-focus`/
 * `blur` events, which fire only for the window that actually became key. Only the
 * truly-focused window spawns; a background window spawns when the user genuinely
 * brings it forward.
 *
 * `TerminalPanel` latches its own init the first time `isActive`/`panelVisible`
 * are true and stays alive thereafter, so once launched we never flip back.
 */
export const ClaudeCliTerminalStrip: React.FC<ClaudeCliTerminalStripProps> = ({
  sessionId,
  workspacePath,
  model,
  focusNonce,
  observeRef,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [launched, setLaunched] = useState(false);
  const onScreenRef = useRef(false);
  const windowFocused = useAtomValue(windowFocusedAtom);

  useEffect(() => {
    if (launched) return;

    // Observe the caller-provided element (drawer root) when given, so the CLI
    // spawns even while the body is collapsed; otherwise fall back to our own
    // container.
    const el = observeRef?.current ?? containerRef.current;
    if (!el) return;

    // Latch only once the strip is on-screen AND this is the OS-focused window.
    const tryLaunch = () => {
      if (onScreenRef.current && windowFocused) {
        setLaunched(true);
      }
    };

    // This effect re-runs when `windowFocused` flips true; if the observer has
    // already reported on-screen (ref persists across runs), launch now. This is
    // how a background window spawns when the user brings it forward.
    tryLaunch();

    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback for environments without IntersectionObserver (older runtimes /
      // jsdom): treat as on-screen and let the focus gate decide.
      onScreenRef.current = true;
      tryLaunch();
    } else {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onScreenRef.current = true;
            tryLaunch();
          }
        }
      });
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
    };
  }, [launched, observeRef, windowFocused]);

  return (
    <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
      <TerminalPanel
        terminalId={sessionId}
        workspacePath={workspacePath}
        isActive={launched}
        panelVisible={launched}
        launchMode="claude-cli"
        claudeCliModel={model}
        focusNonce={focusNonce}
        // NIM-820: never steal focus from the chat input on mount/activation;
        // focusNonce still focuses explicitly for native pickers.
        autoFocus={false}
      />
    </div>
  );
};

export default ClaudeCliTerminalStrip;
