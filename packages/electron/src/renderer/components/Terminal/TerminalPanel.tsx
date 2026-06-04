/**
 * TerminalPanel - Ghostty-web based terminal component
 *
 * Connects to a PTY process via IPC and renders terminal output using Ghostty-web.
 * Handles input, resize, scrollback restoration, and cleanup.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { init, Terminal, FitAddon, OSC8LinkProvider, UrlRegexProvider, type ITheme, type ILinkProvider, type ILink } from 'ghostty-web';
import { themeIdAtom } from '@nimbalyst/runtime/store';
import { TerminalContextMenu } from './TerminalContextMenu';
import { sanitizeScrollback, stripProblematicEscapeSequences, cleanScrollback } from './scrollbackSanitization';

// Type for terminal API is defined in electron.d.ts

export interface TerminalPanelProps {
  /** Terminal ID (ULID) */
  terminalId: string;
  /** Workspace path for store lookups */
  workspacePath: string;
  /** Whether this terminal tab is currently active/visible */
  isActive: boolean;
  /** Whether the parent bottom panel is visible */
  panelVisible?: boolean;
  /** Optional callback when terminal exits */
  onExit?: (exitCode: number) => void;
}

// Track if ghostty WASM has been initialized
let ghosttyInitialized = false;
let ghosttyInitPromise: Promise<void> | null = null;

async function ensureGhosttyInit(): Promise<void> {
  if (ghosttyInitialized) return;
  if (ghosttyInitPromise) return ghosttyInitPromise;

  ghosttyInitPromise = init().then(() => {
    ghosttyInitialized = true;
  });

  return ghosttyInitPromise;
}

async function waitForVisibleTerminalDimensions(
  element: HTMLElement,
  timeoutMs = 1500
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return;
    }
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }

  throw new Error('Terminal container never became measurable');
}

function getVisibleScreenLines(terminal: Terminal): string[] {
  const activeBuffer = terminal.buffer.active;
  const firstVisibleRow = Math.max(0, activeBuffer.length - terminal.rows);
  const lines: string[] = [];

  for (let row = 0; row < terminal.rows; row += 1) {
    const line = activeBuffer.getLine(firstVisibleRow + row);
    lines.push(line?.translateToString(false) ?? '');
  }

  return lines;
}

function escapeScreenLineForReplay(line: string): string {
  return line.replace(/\x1b/g, '').replace(/\r/g, '').replace(/\n/g, '');
}

// Get terminal theme colors from CSS variables
function getTerminalTheme(): ITheme {
  const getCSSVar = (name: string, fallback: string): string => {
    if (typeof document === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };

  return {
    background: getCSSVar('--terminal-bg', '#0d0d0d'),
    foreground: getCSSVar('--terminal-fg', '#ffffff'),
    cursor: getCSSVar('--terminal-cursor', '#60a5fa'),
    cursorAccent: getCSSVar('--terminal-cursor-accent', '#0d0d0d'),
    selectionBackground: getCSSVar('--terminal-selection', 'rgba(255, 255, 255, 0.3)'),
    black: getCSSVar('--terminal-ansi-black', '#000000'),
    red: getCSSVar('--terminal-ansi-red', '#ef4444'),
    green: getCSSVar('--terminal-ansi-green', '#22c55e'),
    yellow: getCSSVar('--terminal-ansi-yellow', '#eab308'),
    blue: getCSSVar('--terminal-ansi-blue', '#3b82f6'),
    magenta: getCSSVar('--terminal-ansi-magenta', '#a855f7'),
    cyan: getCSSVar('--terminal-ansi-cyan', '#06b6d4'),
    white: getCSSVar('--terminal-ansi-white', '#ffffff'),
    brightBlack: getCSSVar('--terminal-ansi-bright-black', '#6b7280'),
    brightRed: getCSSVar('--terminal-ansi-bright-red', '#f87171'),
    brightGreen: getCSSVar('--terminal-ansi-bright-green', '#4ade80'),
    brightYellow: getCSSVar('--terminal-ansi-bright-yellow', '#facc15'),
    brightBlue: getCSSVar('--terminal-ansi-bright-blue', '#60a5fa'),
    brightMagenta: getCSSVar('--terminal-ansi-bright-magenta', '#c084fc'),
    brightCyan: getCSSVar('--terminal-ansi-bright-cyan', '#22d3ee'),
    brightWhite: getCSSVar('--terminal-ansi-bright-white', '#ffffff'),
  };
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  terminalId,
  workspacePath,
  isActive,
  panelVisible,
  onExit,
}) => {
  // Support legacy sessionId prop name
  const sessionId = terminalId;
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [hasExited, setHasExited] = useState(false);
  const hasExitedRef = useRef(false); // Ref to track exit state for callbacks
  const hasAutoRestartedRef = useRef(false); // Track if we've already auto-restarted (prevent loops)
  const initStartTimeRef = useRef<number>(0); // Track when initialization started
  const disposedRef = useRef(false); // Ref to track disposed state for async callbacks
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [restoreWarning, setRestoreWarning] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Use a ref for onExit to avoid effect re-runs when parent passes new callback references
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  // Auto-dismiss the scrollback-restore warning. It's purely informational
  // ("live terminal output continues"), so it should not linger over the
  // prompt line. Clears itself after a few seconds.
  useEffect(() => {
    if (!restoreWarning) return;
    const timer = setTimeout(() => setRestoreWarning(null), 6000);
    return () => clearTimeout(timer);
  }, [restoreWarning]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleClearTerminal = useCallback(() => {
    // Clear the visual terminal (ANSI escape: clear screen + move cursor home)
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.write('\x1B[2J\x1B[H');
    }
    // Clear the persisted scrollback
    window.electronAPI.terminal.clearScrollback(sessionId);
  }, [sessionId]);

  // Handle terminal restart after exit
  // Use a ref to store the restart function to avoid effect re-runs
  const handleRestartRef = useRef<() => Promise<void>>();
  handleRestartRef.current = async () => {
    hasExitedRef.current = false; // Reset ref for callbacks
    setHasExited(false);
    setExitCode(null);
    setInitError(null);
    setRestoreWarning(null);

    try {
      await window.electronAPI.terminal.initialize(terminalId, {
        workspacePath,
        cwd: workspacePath,
      });
    } catch (error) {
      console.error('[TerminalPanel] Failed to restart terminal:', error);
      setInitError(error instanceof Error ? error.message : 'Failed to restart terminal');
    }
  };

  // Stable callback that delegates to the ref
  const handleRestart = useCallback(() => {
    return handleRestartRef.current?.() ?? Promise.resolve();
  }, []);

  // Track if terminal has been initialized (separate from isInitialized state)
  // This ref persists across renders and prevents re-initialization on tab switches
  const hasInitializedRef = useRef(false);

  // Track whether this terminal should initialize. Set to true when the terminal
  // first becomes active, and stays true forever after. This allows us to:
  // 1. Defer initialization until the terminal is visible (so we get valid dimensions)
  // 2. Keep the terminal alive when switching tabs (no dispose/recreate cycle)
  const [shouldInit, setShouldInit] = useState(false);

  // When the terminal is active and the panel is visible, enable initialization.
  // Once initialized, it stays alive even when hidden again.
  useEffect(() => {
    if (isActive && panelVisible && !shouldInit) {
      setShouldInit(true);
    }
  }, [isActive, panelVisible, shouldInit]);

  // Initialize terminal - runs once per terminalId when shouldInit becomes true
  // After initialization, the terminal stays alive in the background when switching tabs
  useEffect(() => {
    // Only initialize once shouldInit is true (terminal has been activated at least once)
    if (!shouldInit) return;

    // Only initialize once the DOM ref is available
    if (!terminalRef.current) return;

    // Skip if already initialized for this terminal
    if (hasInitializedRef.current) return;

    disposedRef.current = false;
    let disposed = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let unsubscribeOutput: (() => void) | null = null;
    let unsubscribeExited: (() => void) | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let focusInHandler: (() => void) | null = null;
    let focusOutHandler: (() => void) | null = null;
    let renderStatePersistTimer: ReturnType<typeof setTimeout> | null = null;

    const persistRenderStateNow = async () => {
      if (!terminal || disposed) return;

      const maxCols = Math.max(1, terminal.cols);
      const maxRows = Math.max(1, terminal.rows);
      const cursorX = Math.max(0, Math.min(terminal.buffer.active.cursorX, maxCols - 1));
      const cursorY = Math.max(0, Math.min(terminal.buffer.active.cursorY, maxRows - 1));
      const screenLines = getVisibleScreenLines(terminal);

      try {
        await window.electronAPI.terminal.updateRenderState(sessionId, {
          workspacePath,
          cols: terminal.cols,
          rows: terminal.rows,
          cursorX,
          cursorY,
          screenLines,
        });
      } catch (error) {
        console.warn('[TerminalPanel] Failed to persist terminal render state:', error);
      }
    };

    const scheduleRenderStatePersist = () => {
      if (renderStatePersistTimer || !terminal || disposed) {
        return;
      }

      renderStatePersistTimer = setTimeout(() => {
        renderStatePersistTimer = null;
        void persistRenderStateNow();
      }, 75);
    };

    const initTerminal = async () => {
      try {
        // Track when initialization started for quick-exit detection
        initStartTimeRef.current = Date.now();

        // Initialize ghostty WASM first
        await ensureGhosttyInit();

        if (disposed) return;

        if (!terminalRef.current) return;
        await waitForVisibleTerminalDimensions(terminalRef.current);

        if (disposed) return;

        // Create Ghostty Terminal instance
        terminal = new Terminal({
          fontSize: 13,
          fontFamily: '"SF Mono", Monaco, "Courier New", monospace',
          scrollback: 50000,
          cursorBlink: false,
          cursorStyle: 'bar',
          theme: getTerminalTheme(),
        });

        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);

        if (terminalRef.current && !disposed) {
          terminal.open(terminalRef.current);
          await new Promise((resolve) => setTimeout(resolve, 0));
          let initialDims: { cols: number; rows: number } | undefined;
          try {
            fitAddon.fit();
            const dims = fitAddon.proposeDimensions();
            if (dims && dims.cols > 0 && dims.rows > 0) {
              initialDims = dims;
            }
          } catch (e) {
            console.warn('[TerminalPanel] Initial fit failed:', e);
          }

          // Initialize PTY if not already active (with timeout) after we know real dimensions.
          const initPromise = window.electronAPI.terminal.initialize(terminalId, {
            workspacePath,
            cwd: workspacePath,
            cols: initialDims?.cols,
            rows: initialDims?.rows,
          });

          const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) => {
            setTimeout(() => {
              resolve({ success: false, error: 'Terminal initialization timed out after 10 seconds' });
            }, 10000);
          });

          const result = await Promise.race([initPromise, timeoutPromise]);

          if (disposed) return;

          if (!result.success && !('alreadyActive' in result && result.alreadyActive)) {
            const errorMessage = result.error || 'Failed to initialize PTY';
            console.error('[TerminalPanel] Failed to initialize PTY:', errorMessage);
            setInitError(errorMessage);
            return;
          }

          if (initialDims) {
            window.electronAPI.terminal.resize(sessionId, initialDims.cols, initialDims.rows);
          }

          terminalInstanceRef.current = terminal;
          fitAddonRef.current = fitAddon;

          // Show cursor as theme color when focused, dim gray when unfocused.
          // Use renderer.setTheme() directly since Terminal.options.theme setter
          // warns that runtime theme changes aren't fully supported.
          const focusedCursorColor = getTerminalTheme().cursor;
          const unfocusedCursorColor = '#666666';

          focusInHandler = () => {
            if (terminal?.renderer && !disposed) {
              terminal.renderer.setTheme({
                ...terminal.options.theme,
                cursor: focusedCursorColor,
              });
            }
          };
          focusOutHandler = () => {
            if (terminal?.renderer && !disposed) {
              terminal.renderer.setTheme({
                ...terminal.options.theme,
                cursor: unfocusedCursorColor,
              });
            }
          };
          terminalRef.current.addEventListener('focusin', focusInHandler);
          terminalRef.current.addEventListener('focusout', focusOutHandler);

          // Start with unfocused cursor color
          terminal.renderer?.setTheme({
            ...terminal.options.theme,
            cursor: unfocusedCursorColor,
          });

          // CRITICAL: Set up PTY output listener BEFORE scrollback restoration,
          // but queue the output to prevent race conditions.
          // This ensures we don't lose output that arrives during scrollback restoration,
          // while also preventing interleaved writes that cause display corruption.
          let scrollbackRestoreComplete = false;
          let lastAppliedSequence = 0;
          const pendingOutput: Array<{ data: string; sequence: number }> = [];

          unsubscribeOutput = window.electronAPI.terminal.onOutput((data) => {
            if (data.sessionId === sessionId && terminal && !disposed) {
              if (data.sequence <= lastAppliedSequence) {
                return;
              }
              if (scrollbackRestoreComplete) {
                // Normal path: write directly to terminal
                terminal.write(data.data);
                lastAppliedSequence = data.sequence;
                scheduleRenderStatePersist();
              } else {
                // Queue output during scrollback restoration to prevent interleaving
                pendingOutput.push(data);
              }
            }
          });

          const snapshot = await window.electronAPI.terminal.getRestoreSnapshot(workspacePath, sessionId);
          lastAppliedSequence = snapshot.sequence;

          // Restore scrollback if available
          if (snapshot.scrollback && !disposed) {
            // Sanitize the scrollback to remove invalid code points that could crash
            // the terminal's render loop. This must happen BEFORE any write attempts.
            const sanitized = sanitizeScrollback(snapshot.scrollback);

            if (sanitized === null) {
              console.warn('[TerminalPanel] Scrollback is corrupted, skipping restore');
              setRestoreWarning('Saved terminal history could not be restored cleanly. Live terminal output continues.');
            } else {
              // Strip escape sequences that can corrupt terminal state when replayed
              const stripped = stripProblematicEscapeSequences(sanitized);
              // Clean up the scrollback to remove trailing whitespace that was
              // added for a potentially different terminal width
              const cleaned = cleanScrollback(stripped);

              // Write scrollback in chunks to avoid WASM memory issues.
              // Use smaller chunks and yield between them to keep UI responsive.
              // If writing takes too long or fails, clear the corrupted data.
              const CHUNK_SIZE = 8192; // 8KB chunks (smaller for smoother UI)
              const MAX_RESTORE_TIME_MS = 2000; // Abort if restoration takes too long
              const startTime = Date.now();
              let writeError: Error | null = null;
              let timedOut = false;

              const writeChunks = async () => {
                for (let i = 0; i < cleaned.length; i += CHUNK_SIZE) {
                  if (disposed || !terminal) return;

                  // Check timeout
                  if (Date.now() - startTime > MAX_RESTORE_TIME_MS) {
                    console.warn('[TerminalPanel] Scrollback restoration timed out, skipping remaining history');
                    timedOut = true;
                    return;
                  }

                  try {
                    terminal.write(cleaned.slice(i, i + CHUNK_SIZE));
                  } catch (err) {
                    writeError = err instanceof Error ? err : new Error(String(err));
                    break;
                  }

                  // Yield to the event loop every few chunks to keep UI responsive
                  if ((i / CHUNK_SIZE) % 4 === 3) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                  }
                }
              };

              try {
                await writeChunks();
              } catch (err) {
                writeError = err instanceof Error ? err : new Error(String(err));
              }

              if (writeError) {
                console.warn('[TerminalPanel] Failed to restore scrollback, keeping persisted history:', writeError);
                setRestoreWarning('Saved terminal history restored partially. Live terminal output continues.');
              } else if (timedOut) {
                setRestoreWarning('Saved terminal history restored partially because replay took too long.');
              } else if (terminal && !disposed) {
                // Reset scroll margins to full screen to clear any stale scroll region
                // from the scrollback content.
                // CSI r = Set scroll region to entire screen
                terminal.write('\x1b[r');
                terminal.scrollToBottom();

                if (snapshot.screenLines && snapshot.screenLines.length > 0) {
                  const visibleLines = snapshot.screenLines.slice(-terminal.rows);
                  for (let row = 0; row < visibleLines.length; row += 1) {
                    const line = escapeScreenLineForReplay(visibleLines[row]);
                    terminal.write(`\x1b[${row + 1};1H\x1b[2K${line}`);
                  }
                }

                if (snapshot.cursorX !== undefined && snapshot.cursorY !== undefined) {
                  const cursorRow = Math.max(0, Math.min(snapshot.cursorY, terminal.rows - 1));
                  const cursorCol = Math.max(0, Math.min(snapshot.cursorX, terminal.cols - 1));
                  terminal.write(`\x1b[${cursorRow + 1};${cursorCol + 1}H`);
                }
              }
            }
          }

          // Mark scrollback restoration as complete and flush any queued output
          scrollbackRestoreComplete = true;
          if (pendingOutput.length > 0 && terminal && !disposed) {
            for (const pending of pendingOutput) {
              if (pending.sequence <= lastAppliedSequence) continue;
              terminal.write(pending.data);
              lastAppliedSequence = pending.sequence;
            }
          }
          scheduleRenderStatePersist();

          // Listen for PTY exit
          unsubscribeExited = window.electronAPI.terminal.onExited((data) => {
            if (data.sessionId === terminalId && !disposed) {
              hasExitedRef.current = true; // Update ref immediately for callbacks

              // Auto-restart if terminal exits very quickly after init (likely a stale/broken session)
              // Only do this once to prevent infinite restart loops
              const timeSinceInit = Date.now() - initStartTimeRef.current;
              const QUICK_EXIT_THRESHOLD_MS = 2000;

              if (timeSinceInit < QUICK_EXIT_THRESHOLD_MS && !hasAutoRestartedRef.current) {
                hasAutoRestartedRef.current = true;
                hasExitedRef.current = false;
                // Restart after a brief delay to let things settle
                // Use ref to check disposed state at time of execution (not closure)
                setTimeout(() => {
                  if (!disposedRef.current) {
                    handleRestart();
                  }
                }, 100);
                return; // Don't show exit UI, we're restarting
              }

              setHasExited(true);
              setExitCode(data.exitCode);
              onExitRef.current?.(data.exitCode);
            }
          });

          // Send input to PTY
          // Use ref instead of state to avoid stale closure issues
          inputDisposable = terminal.onData((data) => {
            if (!disposed) {
              // If terminal has exited and user presses Enter, restart it
              if (hasExitedRef.current && data === '\r') {
                handleRestart();
              } else if (!hasExitedRef.current) {
                window.electronAPI.terminal.write(sessionId, data);
              }
            }
          });

          // Handle resize
          resizeObserver = new ResizeObserver(() => {
            if (fitAddon && !disposed) {
              try {
                fitAddon.fit();
                const dims = fitAddon.proposeDimensions();
                if (dims && dims.cols > 0 && dims.rows > 0) {
                  window.electronAPI.terminal.resize(sessionId, dims.cols, dims.rows);
                  scheduleRenderStatePersist();
                }
              } catch (e) {
                // Ignore resize errors during cleanup
              }
            }
          });
          resizeObserver.observe(terminalRef.current);

          // Register link providers that open URLs in the default browser
          const wrapProvider = (provider: ILinkProvider): ILinkProvider => ({
            provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
              provider.provideLinks(y, (links) => {
                if (!links) {
                  callback(undefined);
                  return;
                }
                callback(links.map((link) => ({
                  ...link,
                  activate: () => {
                    window.electronAPI.openExternal(link.text);
                  },
                })));
              });
            },
            dispose() {
              provider.dispose?.();
            },
          });
          terminal.registerLinkProvider(wrapProvider(new OSC8LinkProvider(terminal)));
          terminal.registerLinkProvider(wrapProvider(new UrlRegexProvider(terminal)));

          setIsInitialized(true);
          hasInitializedRef.current = true;
          scheduleRenderStatePersist();

          // Auto-focus if this is the active terminal and panel is visible
          if (isActive) {
            setTimeout(() => terminal?.focus(), 50);
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('[TerminalPanel] Error initializing terminal:', error);
        setInitError(errorMessage);
      }
    };

    initTerminal();

    return () => {
      if (renderStatePersistTimer) {
        clearTimeout(renderStatePersistTimer);
        renderStatePersistTimer = null;
      }
      void persistRenderStateNow();
      disposed = true;
      disposedRef.current = true;
      hasInitializedRef.current = false;
      resizeObserver?.disconnect();
      if (focusInHandler && terminalRef.current) {
        terminalRef.current.removeEventListener('focusin', focusInHandler);
      }
      if (focusOutHandler && terminalRef.current) {
        terminalRef.current.removeEventListener('focusout', focusOutHandler);
      }
      unsubscribeOutput?.();
      unsubscribeExited?.();
      inputDisposable?.dispose();
      terminal?.dispose();
      fitAddon?.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  // Note: shouldInit triggers this effect when the terminal first becomes active.
  // After initialization, shouldInit stays true, so the terminal persists in the background.
  // Note: isActive is NOT in deps - we don't want to dispose/recreate terminal on tab switches.
  // Note: hasExited is NOT in deps - we use hasExitedRef instead to avoid
  // effect re-runs when terminal exits (which would dispose and recreate it)
  // Note: onExit and handleRestart are NOT in deps - we use refs for both to avoid
  // effect re-runs when callbacks change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, workspacePath, shouldInit]);

  // Blur terminal when panel hides, focus when it shows
  useEffect(() => {
    if (!terminalInstanceRef.current) return;
    if (isActive && panelVisible) {
      // Panel became visible - focus and re-fit after DOM updates
      setTimeout(() => {
        terminalInstanceRef.current?.focus();
      }, 50);
    } else if (!panelVisible) {
      // Panel hidden - blur terminal
      terminalInstanceRef.current.blur();
    }
  }, [isActive, panelVisible]);

  // Re-fit when becoming active or panel becomes visible (size may have changed while hidden)
  useEffect(() => {
    if (isActive && panelVisible && fitAddonRef.current) {
      setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          const dims = fitAddonRef.current?.proposeDimensions();
          if (dims && dims.cols > 0 && dims.rows > 0) {
            window.electronAPI.terminal.resize(sessionId, dims.cols, dims.rows);
          }
        } catch (e) {
          // Ignore
        }
      }, 50);
    }
  }, [isActive, panelVisible, sessionId]);

  // React to theme changes by re-reading CSS vars into the terminal instance.
  // themeIdAtom is updated by store/listeners/themeListeners.ts.
  const currentThemeId = useAtomValue(themeIdAtom);
  useEffect(() => {
    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.options.theme = getTerminalTheme();
    }
  }, [currentThemeId]);

  return (
    <div
      className="terminal-panel"
      style={{
        height: '100%',
        width: '100%',
        position: 'relative',
        backgroundColor: 'var(--terminal-bg)',
        display: 'flex',
        flexDirection: 'column',
        padding: '8px',
      }}
    >
      <div
        ref={terminalRef}
        className="terminal-container"
        style={{
          flex: 1,
          overflow: 'hidden',
          caretColor: 'transparent',
        }}
        data-testid="terminal-container"
        onContextMenu={handleContextMenu}
      />

      {contextMenu && (
        <TerminalContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={handleCloseContextMenu}
          onClear={handleClearTerminal}
        />
      )}

      {restoreWarning && !initError && !hasExited && (
        <div
          style={{
            position: 'absolute',
            top: '8px',
            left: '8px',
            right: '8px',
            padding: '8px 12px',
            backgroundColor: 'var(--nim-bg-secondary)',
            borderRadius: '4px',
            color: 'var(--nim-text-muted)',
            fontSize: '12px',
            border: '1px solid var(--nim-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <span>{restoreWarning}</span>
          <button
            type="button"
            onClick={() => setRestoreWarning(null)}
            aria-label="Dismiss"
            style={{
              flexShrink: 0,
              background: 'none',
              border: 'none',
              color: 'var(--nim-text-muted)',
              cursor: 'pointer',
              fontSize: '14px',
              lineHeight: 1,
              padding: '0 2px',
            }}
          >
            x
          </button>
        </div>
      )}

      {!isInitialized && !hasExited && !initError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--nim-text-faint)',
            fontSize: '14px',
          }}
        >
          Initializing terminal...
        </div>
      )}

      {initError && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-nim-error text-sm p-5 text-center"
        >
          <div style={{ marginBottom: '12px' }}>
            Failed to initialize terminal: {initError}
          </div>
          <button
            onClick={handleRestart}
            style={{
              padding: '6px 12px',
              backgroundColor: 'var(--nim-bg-tertiary)',
              border: 'none',
              borderRadius: '4px',
              color: 'var(--nim-text)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {hasExited && (
        <div
          style={{
            position: 'absolute',
            bottom: '8px',
            left: '8px',
            right: '8px',
            padding: '8px 12px',
            backgroundColor: 'var(--nim-bg-secondary)',
            borderRadius: '4px',
            color: 'var(--nim-text-muted)',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>
            Process exited with code {exitCode ?? 0}.
          </span>
          <button
            onClick={handleRestart}
            style={{
              padding: '4px 8px',
              backgroundColor: 'var(--nim-bg-tertiary)',
              border: 'none',
              borderRadius: '4px',
              color: 'var(--nim-text)',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
};

export default TerminalPanel;
