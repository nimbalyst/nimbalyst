import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { setInteractiveWidgetHost } from '@nimbalyst/runtime/store';
// Deep imports to avoid the barrel @nimbalyst/runtime index which re-exports
// Lexical plugins, TrackerPlugin, etc. and transitively pulls in
// Excalidraw (~18MB), Mermaid, and other heavy deps. The barrel's `export *`
// prevents tree-shaking, producing a ~25MB bundle that crashes WKWebView.
import { AgentTranscriptPanel } from '@nimbalyst/runtime/ui/AgentTranscript/components/AgentTranscriptPanel';
import { noopInteractiveWidgetHost } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript/projectRawMessages';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { InteractiveWidgetHost } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';
import './styles.css';

// ============================================================================
// Types for Kotlin <-> JS bridge
// ============================================================================

interface BridgeSessionData {
  sessionId: string;
  messages: BridgeMessage[];
  // Native sets this when its message list no longer extends what it last
  // sent (a row vanished or was reordered). The cache-hit path below would
  // otherwise keep the stale list because it only accepts growth.
  replace?: boolean;
  metadata: {
    title?: string;
    provider?: string;
    model?: string;
    mode?: string;
    isExecuting?: boolean;
  };
}

interface BridgeMessage {
  id: string;
  sessionId: string;
  sequence: number;
  source: string;
  direction: string;
  contentDecrypted: string | null;
  metadataJson: string | null;
  createdAt: number;
}

interface BridgeMetadataUpdate {
  title?: string;
  provider?: string;
  model?: string;
  mode?: string;
  isExecuting?: boolean;
}

// Up to N sessions kept mounted simultaneously. Switching back to a cached
// session is then a CSS visibility toggle — no React reflow, no VList re-mount,
// scroll position preserved.
const CACHE_CAPACITY = 3;

interface SessionEntry {
  sessionId: string;
  rawMessages: BridgeMessage[];
  metadata: BridgeMetadataUpdate;
}

function lastMessageId(messages: BridgeMessage[]): string | null {
  return messages.length > 0 ? messages[messages.length - 1].id : null;
}

function metadataEqual(a: BridgeMetadataUpdate, b: BridgeMetadataUpdate): boolean {
  return (
    a.title === b.title &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.mode === b.mode &&
    a.isExecuting === b.isExecuting
  );
}

interface TranscriptHandle {
  scrollToMessage: (index: number) => void;
  scrollToTop: () => void;
}

// ============================================================================
// Convert bridge messages to the format transformAgentMessagesToViewMessages expects
// ============================================================================

function bridgeMessageToRaw(msg: BridgeMessage, syntheticId: number): RawMessage {
  const raw = msg.contentDecrypted || '';

  // The encrypted payload is an envelope: { content: "...", metadata: {...}, hidden: false }.
  // Unwrap to the actual message content expected by the raw-message parsers
  // (e.g. Claude Code JSON chunks, Codex SDK events).
  try {
    const envelope = JSON.parse(raw);
    if (envelope && typeof envelope === 'object' && 'content' in envelope) {
      return {
        id: syntheticId,
        sessionId: msg.sessionId,
        source: msg.source,
        direction: msg.direction as 'input' | 'output',
        content: typeof envelope.content === 'string' ? envelope.content : JSON.stringify(envelope.content),
        createdAt: new Date(msg.createdAt),
        metadata: envelope.metadata || (msg.metadataJson ? tryParseJson(msg.metadataJson) : undefined),
        hidden: envelope.hidden,
      };
    }
  } catch {
    // Not JSON envelope - use as-is
  }

  return {
    id: syntheticId,
    sessionId: msg.sessionId,
    source: msg.source,
    direction: msg.direction as 'input' | 'output',
    content: raw,
    createdAt: new Date(msg.createdAt),
    metadata: msg.metadataJson ? tryParseJson(msg.metadataJson) : undefined,
  };
}

function tryParseJson(json: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function postToNative(message: Record<string, unknown>) {
  try {
    const androidBridge = (window as any).AndroidBridge;
    if (androidBridge?.postMessage) {
      androidBridge.postMessage(JSON.stringify(message));
      return;
    }

    (window as any).webkit?.messageHandlers?.bridge?.postMessage(message);
  } catch (e) {
    console.warn('Failed to post to native:', e);
  }
}

function postHaptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  postToNative({ type: 'haptic', style });
}

// ============================================================================
// Mobile Interactive Widget Host
// Bridges interactive widget responses back to the native host
// ============================================================================

function createMobileBridgeHost(sessionId: string): InteractiveWidgetHost {
  return {
    ...noopInteractiveWidgetHost,
    sessionId,
    workspacePath: '',

    async askUserQuestionSubmit(questionId: string, answers: Record<string, string>) {
      postHaptic();
      postToNative({ type: 'interactive_response', sessionId, action: 'askUserQuestionSubmit', questionId, answers });
    },

    async requestUserInputSubmit(promptId: string, answers: Record<string, unknown>) {
      postHaptic();
      postToNative({ type: 'interactive_response', sessionId, action: 'requestUserInputSubmit', promptId, answers });
    },

    async requestUserInputCancel(promptId: string) {
      postToNative({ type: 'interactive_response', sessionId, action: 'requestUserInputCancel', promptId });
    },

    async toolPermissionSubmit(requestId: string, response: any) {
      postToNative({ type: 'interactive_response', sessionId, action: 'toolPermissionSubmit', requestId, response });
    },

    async exitPlanModeApprove(requestId: string) {
      postToNative({ type: 'interactive_response', sessionId, action: 'exitPlanModeApprove', requestId });
    },

    async exitPlanModeDeny(requestId: string, feedback?: string) {
      postToNative({ type: 'interactive_response', sessionId, action: 'exitPlanModeDeny', requestId, feedback });
    },

    async gitCommit(proposalId: string, files: string[], message: string) {
      postToNative({ type: 'interactive_response', sessionId, action: 'gitCommit', proposalId, files, message });
      return { success: true, pending: true };
    },

    async gitCommitCancel(proposalId: string) {
      postToNative({ type: 'interactive_response', sessionId, action: 'gitCommitCancel', proposalId });
    },

    trackEvent() {
      // No-op on mobile
    },
  };
}

// ============================================================================
// Error Boundary — catches React render errors and reports them to native
// ============================================================================

function postErrorToNative(label: string, error: unknown) {
  const msg = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  console.error(`[TranscriptError] ${label}: ${msg}`);
  postToNative({
    type: 'js_error',
    message: `[${label}] ${msg}`,
    url: 'transcript/main.tsx',
    line: 0,
    col: 0,
    stack: error instanceof Error ? error.stack || '' : '',
  });
}

function isBenignWindowErrorMessage(message: string): boolean {
  return message === 'ResizeObserver loop completed with undelivered notifications.';
}

// Detailed error capture -- runs BEFORE React mounts so we catch bundle-eval
// errors too. Uses addEventListener (not window.onerror) so we can read the
// real Error object from the event.
try {
  window.addEventListener('error', (event) => {
    try {
      const err = event.error;
      const messageText = err instanceof Error
        ? err.message
        : String(event.message || err || 'unknown');
      if (isBenignWindowErrorMessage(messageText)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      const msg = err instanceof Error
        ? `${err.message}\n${err.stack ?? ''}`
        : messageText;
      postToNative({
        type: 'js_error',
        message: `[window.error] ${msg}`,
        url: event.filename || 'transcript/main.tsx',
        line: event.lineno ?? 0,
        col: event.colno ?? 0,
        stack: err instanceof Error ? err.stack || '' : '',
      });
    } catch {
      // swallow
    }
  });
  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason: any = event.reason;
      const reasonMessage = reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : (() => { try { return JSON.stringify(reason); } catch { return String(reason); } })();
      if (isBenignWindowErrorMessage(reasonMessage)) {
        event.preventDefault();
        return;
      }

      const msg = reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : reasonMessage;
      postToNative({
        type: 'js_error',
        message: `[unhandledrejection] ${msg}`,
        url: 'transcript/main.tsx',
        line: 0,
        col: 0,
        stack: reason instanceof Error ? reason.stack || '' : '',
      });
    } catch {
      // swallow
    }
  });
} catch {
  // No window (should not happen in a WebView)
}

// External links: hand http(s)/mailto anchors to native instead of letting the
// WebView navigate away from transcript.html. Native also intercepts any
// navigation that slips through (shouldOverrideUrlLoading), so this is the
// fast path, not the only one.
try {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.href;
    if (!/^(https?:|mailto:)/i.test(href)) return;
    event.preventDefault();
    postToNative({ type: 'open_url', url: href });
  }, true);
} catch {
  // swallow
}

class TranscriptErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    postErrorToNative('ReactRenderError', new Error(`${error.message}\nComponent stack: ${info.componentStack}`));
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: '#ef4444', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
          <strong>Transcript render error:</strong>{'\n'}{this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================
// Transcript App — multi-session LRU cache (CACHE_CAPACITY entries kept
// mounted). Inactive sessions stay in the DOM with `visibility: hidden` so
// their scroll position, expansion state, and virtual-list windows survive a
// round trip. The active session is the one Kotlin is currently feeding via
// appendMessages/updateMetadata.
// ============================================================================

function TranscriptApp() {
  // All hooks BEFORE any early return.
  const [sessions, setSessions] = useState<Record<string, SessionEntry>>({});
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  // Refs mirror state so bridge handlers (defined inside a useEffect with []
  // deps) read current values without stale closures, and so cross-handler
  // sync reads work correctly between batched React updates.
  const sessionsRef = useRef<Record<string, SessionEntry>>({});
  const activeSessionIdRef = useRef<string | null>(null);
  sessionsRef.current = sessions;
  activeSessionIdRef.current = activeSessionId;

  // LRU order, oldest first. Touched on every loadSession.
  const lruRef = useRef<string[]>([]);

  // Per-session refs registered upward by SessionView so the bridge's
  // scrollToTop / scrollToMessage / getPromptList can route to the active
  // session's panel without re-rendering.
  const transcriptRefsRef = useRef<Map<string, TranscriptHandle>>(new Map());
  const sessionDataRefsRef = useRef<Map<string, SessionData>>(new Map());

  // Set up the bridge on window.nimbalyst - runs once on mount, never re-runs
  useEffect(() => {
    // Deltas and metadata updates are computed by Kotlin against ITS idea of
    // the current session. If the two sides have drifted, grafting them onto
    // whatever is active writes one session's messages into another's
    // transcript. Every mutation names its session, and one that isn't the
    // active one is rejected so native falls back to a full loadSession.
    const applyToSession = (
      sessionId: string,
      mutate: (entry: SessionEntry) => SessionEntry
    ): boolean => {
      const activeId = activeSessionIdRef.current;
      if (!activeId || !sessionId || sessionId !== activeId) return false;
      const entry = sessionsRef.current[activeId];
      if (!entry) return false;
      const next = { ...sessionsRef.current, [activeId]: mutate(entry) };
      sessionsRef.current = next;
      setSessions(next);
      return true;
    };

    // Debug helpers are always attached but answer only when native has set
    // window.__nimbalystDebug (debug builds). There is no document-start
    // script hook here, so the flag can land after mount.
    const debugOnly = <T,>(fn: () => T) => (): T | null =>
      (window as any).__nimbalystDebug === true ? fn() : null;

    const nimbalyst: Record<string, unknown> = {
      // Returns the sessionId now active so native can verify the transcript
      // on screen is the one it asked for. The WebView is pooled, so an
      // unverified load can leave the previous session's transcript visible.
      loadSession(data: BridgeSessionData): string | null {
        try {
          const id = data.sessionId;
          const incomingMessages = data.messages || [];
          const incomingMetadata = data.metadata || {};

          activeSessionIdRef.current = id;
          lruRef.current = [...lruRef.current.filter((x) => x !== id), id];
          // Widget host is stateless; (re)registering is idempotent.
          setInteractiveWidgetHost(id, createMobileBridgeHost(id));

          const prev = sessionsRef.current;
          const existing = prev[id];

          if (existing) {
            // Cache hit. A switch back to an unchanged session must be a pure
            // visibility toggle so the transform effect and VList never re-run.
            // Unlike iOS, any difference adopts the incoming list, shorter
            // included: Kotlin computes later appends from exactly what it sent
            // here, so keeping a longer cached list would duplicate them.
            const supersedes =
              data.replace === true ||
              incomingMessages.length !== existing.rawMessages.length ||
              lastMessageId(incomingMessages) !== lastMessageId(existing.rawMessages);
            const metaChanged = !metadataEqual(existing.metadata, incomingMetadata);

            if (!supersedes && !metaChanged) {
              setActiveSessionId(id);
              return id;
            }

            const next = {
              ...prev,
              [id]: {
                sessionId: id,
                rawMessages: supersedes ? incomingMessages : existing.rawMessages,
                metadata: incomingMetadata,
              },
            };
            sessionsRef.current = next;
            setSessions(next);
            setActiveSessionId(id);
            return id;
          }

          // Cache miss — create the entry and evict the LRU session if over
          // capacity. Never evict the session being added.
          let next: Record<string, SessionEntry> = {
            ...prev,
            [id]: { sessionId: id, rawMessages: incomingMessages, metadata: incomingMetadata },
          };
          if (Object.keys(next).length > CACHE_CAPACITY) {
            const evict = lruRef.current.filter((x) => next[x] && x !== id)[0];
            if (evict) {
              const { [evict]: _dropped, ...rest } = next;
              next = rest;
              setInteractiveWidgetHost(evict, null);
              transcriptRefsRef.current.delete(evict);
              sessionDataRefsRef.current.delete(evict);
              lruRef.current = lruRef.current.filter((x) => x !== evict);
            }
          }
          sessionsRef.current = next;
          setSessions(next);
          setActiveSessionId(id);
          return id;
        } catch (e) {
          postErrorToNative('loadSession', e);
          return null;
        }
      },

      appendMessage(message: BridgeMessage, sessionId: string) {
        return applyToSession(sessionId, (entry) => ({
          ...entry,
          rawMessages: [...entry.rawMessages, message],
        }));
      },

      appendMessages(messages: BridgeMessage[], sessionId: string) {
        if (messages.length === 0) return true;
        return applyToSession(sessionId, (entry) => ({
          ...entry,
          rawMessages: [...entry.rawMessages, ...messages],
        }));
      },

      updateMetadata(update: BridgeMetadataUpdate, sessionId: string) {
        return applyToSession(sessionId, (entry) => ({
          ...entry,
          metadata: { ...entry.metadata, ...update },
        }));
      },

      clearSession() {
        Object.keys(sessionsRef.current).forEach((id) => setInteractiveWidgetHost(id, null));
        sessionsRef.current = {};
        setSessions({});
        activeSessionIdRef.current = null;
        setActiveSessionId(null);
        lruRef.current = [];
        transcriptRefsRef.current.clear();
        sessionDataRefsRef.current.clear();
      },

      scrollToTop() {
        const id = activeSessionIdRef.current;
        if (id) transcriptRefsRef.current.get(id)?.scrollToTop();
      },

      scrollToMessage(messageId: string) {
        const id = activeSessionIdRef.current;
        if (!id) return;
        // messageId is actually a UI message index (stringified) from getPromptList
        const index = parseInt(messageId, 10);
        if (!isNaN(index)) {
          transcriptRefsRef.current.get(id)?.scrollToMessage(index);
        }
      },

      getPromptList(): Array<{ id: string; text: string; createdAt: number }> {
        const id = activeSessionIdRef.current;
        if (!id) return [];
        const sd = sessionDataRefsRef.current.get(id);
        if (!sd) return [];
        // Use transformed UI messages (same as desktop PromptMarker extraction)
        // so that the returned indices match the VList item positions.
        return sd.messages
          .map((msg, index) => ({ msg, index }))
          .filter(({ msg }) => msg.type === 'user_message')
          .map(({ msg, index }) => ({
            id: String(index),
            text: (msg.text || '').substring(0, 80),
            createdAt: msg.createdAt?.getTime() || 0,
          }));
      },

      // Diagnostics for chrome://inspect.
      _debugRaw: debugOnly(() => {
        const id = activeSessionIdRef.current;
        const raws = id ? (sessionsRef.current[id]?.rawMessages ?? []) : [];
        return raws.map((m) => {
          let parsedType: string | undefined;
          let itemType: string | undefined;
          let toolName: string | undefined;
          try {
            const env = JSON.parse(m.contentDecrypted || '');
            const inner = typeof env?.content === 'string' ? JSON.parse(env.content) : env?.content;
            parsedType = inner?.type;
            itemType = inner?.item?.type;
            toolName = inner?.item?.tool || inner?.item?.name;
          } catch { /* ignore */ }
          return {
            id: m.id,
            seq: m.sequence,
            source: m.source,
            direction: m.direction,
            type: parsedType,
            itemType,
            toolName,
            len: (m.contentDecrypted || '').length,
          };
        });
      }),
      _debugView: debugOnly(() => {
        const id = activeSessionIdRef.current;
        if (!id) return [];
        const sd = sessionDataRefsRef.current.get(id);
        if (!sd) return [];
        return sd.messages.map((m) => ({
          type: m.type,
          toolName: (m as any).toolCall?.toolName,
          textPreview: m.text ? m.text.slice(0, 60) : undefined,
        }));
      }),
      _debugCache: debugOnly(() => ({
        active: activeSessionIdRef.current,
        lru: [...lruRef.current],
        sessions: Object.fromEntries(
          Object.entries(sessionsRef.current).map(([id, e]) => [id, { messages: e.rawMessages.length }]),
        ),
      })),
    };

    (window as any).nimbalyst = nimbalyst;

    postToNative({ type: 'ready' });

    return () => {
      delete (window as any).nimbalyst;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Actionable posts name their session so native can drop one that raced a
  // session switch or a pooled view being handed to another screen.
  const handleCompact = useCallback((sessionId: string) => {
    postToNative({ type: 'prompt', text: '/compact', sessionId });
  }, []);

  const handleOpenFile = useCallback((sessionId: string, filePath: string) => {
    postToNative({ type: 'open_file', filePath, sessionId });
  }, []);

  const registerTranscriptRef = useCallback((id: string, ref: TranscriptHandle | null) => {
    if (ref) transcriptRefsRef.current.set(id, ref);
    else transcriptRefsRef.current.delete(id);
  }, []);

  const registerSessionData = useCallback((id: string, data: SessionData | null) => {
    if (data) sessionDataRefsRef.current.set(id, data);
    else sessionDataRefsRef.current.delete(id);
  }, []);

  const cachedEntries = Object.values(sessions);

  if (cachedEntries.length === 0 || activeSessionId === null) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        color: 'var(--nim-text-faint)',
        fontSize: '14px',
      }}>
        Waiting for session...
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {cachedEntries.map((entry) => (
        <SessionView
          key={entry.sessionId}
          entry={entry}
          isActive={entry.sessionId === activeSessionId}
          onCompact={handleCompact}
          onOpenFile={handleOpenFile}
          registerTranscriptRef={registerTranscriptRef}
          registerSessionData={registerSessionData}
        />
      ))}
    </div>
  );
}

// ============================================================================
// SessionView — one per cached session. Hidden sessions stay mounted so their
// DOM (scroll position, expansion state, virtual-list window) survives a swap.
// ============================================================================

interface SessionViewProps {
  entry: SessionEntry;
  isActive: boolean;
  onCompact: (sessionId: string) => void;
  onOpenFile: (sessionId: string, filePath: string) => void;
  registerTranscriptRef: (id: string, ref: TranscriptHandle | null) => void;
  registerSessionData: (id: string, data: SessionData | null) => void;
}

function SessionView({
  entry,
  isActive,
  onCompact,
  onOpenFile,
  registerTranscriptRef,
  registerSessionData,
}: SessionViewProps) {
  // All hooks before any early return.
  const transcriptRef = useRef<TranscriptHandle>(null);
  const [viewMessages, setViewMessages] = useState<TranscriptViewMessage[]>([]);

  // Transform raw bridge messages to UI format via the canonical transcript
  // pipeline (per-provider parser -> in-memory projector).
  useEffect(() => {
    let cancelled = false;
    try {
      const provider = entry.metadata.provider || 'claude-code';
      const rawForTransform: RawMessage[] = entry.rawMessages.map((m, i) => bridgeMessageToRaw(m, i + 1));
      projectRawMessagesToViewMessages(rawForTransform, provider)
        .then((vms) => {
          if (!cancelled) setViewMessages(vms);
        })
        .catch((e) => {
          if (!cancelled) postErrorToNative('projectRawMessages:async', e);
        });
    } catch (e) {
      postErrorToNative('projectRawMessages:sync', e);
    }
    return () => {
      cancelled = true;
    };
  }, [entry.rawMessages, entry.metadata.provider]);

  const sessionData: SessionData = useMemo(() => {
    let sessionStatus: string | undefined;
    if (entry.metadata.isExecuting) {
      sessionStatus = 'running';
    }
    return {
      id: entry.sessionId,
      provider: entry.metadata.provider || 'unknown',
      model: entry.metadata.model,
      mode: entry.metadata.mode as 'planning' | 'agent' | undefined,
      messages: viewMessages,
      title: entry.metadata.title,
      createdAt: entry.rawMessages[0]?.createdAt || Date.now(),
      updatedAt: entry.rawMessages[entry.rawMessages.length - 1]?.createdAt || Date.now(),
      metadata: sessionStatus ? { sessionStatus } : undefined,
    };
  }, [entry, viewMessages]);

  const handleCompact = useCallback(() => onCompact(entry.sessionId), [onCompact, entry.sessionId]);
  const handleFileClick = useCallback(
    (filePath: string) => onOpenFile(entry.sessionId, filePath),
    [onOpenFile, entry.sessionId],
  );

  // Publish refs upward so the bridge can route scrollTo / getPromptList to
  // the active session. Deregister on unmount (e.g. LRU eviction).
  useEffect(() => {
    registerTranscriptRef(entry.sessionId, transcriptRef.current);
    registerSessionData(entry.sessionId, sessionData);
    return () => {
      registerTranscriptRef(entry.sessionId, null);
      registerSessionData(entry.sessionId, null);
    };
  }, [entry.sessionId, sessionData, registerTranscriptRef, registerSessionData]);

  // Stack all SessionViews via absolute positioning; visibility:hidden (rather
  // than display:none) keeps layout alive so VList's ResizeObserver doesn't see
  // a 0x0 size and reset its scroll state when a session is hidden.
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        visibility: isActive ? 'visible' : 'hidden',
        pointerEvents: isActive ? 'auto' : 'none',
      }}
      data-session-id={entry.sessionId}
      data-active={isActive ? 'true' : 'false'}
    >
      <AgentTranscriptPanel
        ref={transcriptRef}
        sessionId={entry.sessionId}
        sessionData={sessionData}
        hideSidebar={true}
        onCompact={handleCompact}
        onFileClick={handleFileClick}
      />
    </div>
  );
}

// ============================================================================
// Mount
// ============================================================================

ReactDOM.createRoot(document.getElementById('transcript-root')!).render(
  <JotaiProvider store={store}>
    <TranscriptErrorBoundary>
      <TranscriptApp />
    </TranscriptErrorBoundary>
  </JotaiProvider>
);
