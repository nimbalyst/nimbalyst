import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { setInteractiveWidgetHost } from '@nimbalyst/runtime/store';
// Deep imports to avoid the barrel @nimbalyst/runtime index which re-exports
// Lexical plugins, MockupPlugin, TrackerPlugin, etc. and transitively pulls in
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
// Types for Swift <-> JS bridge
// ============================================================================

interface BridgeSessionData {
  sessionId: string;
  messages: BridgeMessage[];
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

// ============================================================================
// Mobile Interactive Widget Host
// Bridges interactive widget responses back to Swift via WKWebView
// ============================================================================

function createMobileBridgeHost(sessionId: string): InteractiveWidgetHost {
  const postToNative = (message: Record<string, unknown>) => {
    try {
      (window as any).webkit?.messageHandlers?.bridge?.postMessage(message);
    } catch (e) {
      console.warn('Failed to post to native:', e);
    }
  };

  return {
    ...noopInteractiveWidgetHost,
    sessionId,
    workspacePath: '',

    async askUserQuestionSubmit(questionId: string, answers: Record<string, string>) {
      postToNative({ type: 'interactive_response', action: 'askUserQuestionSubmit', questionId, answers });
    },

    async requestUserInputSubmit(promptId: string, answers: Record<string, unknown>) {
      postToNative({ type: 'interactive_response', action: 'requestUserInputSubmit', promptId, answers });
    },

    async requestUserInputCancel(promptId: string) {
      postToNative({ type: 'interactive_response', action: 'requestUserInputCancel', promptId });
    },

    async toolPermissionSubmit(requestId: string, response: any) {
      postToNative({ type: 'interactive_response', action: 'toolPermissionSubmit', requestId, response });
    },

    async exitPlanModeApprove(requestId: string) {
      postToNative({ type: 'interactive_response', action: 'exitPlanModeApprove', requestId });
    },

    async exitPlanModeDeny(requestId: string, feedback?: string) {
      postToNative({ type: 'interactive_response', action: 'exitPlanModeDeny', requestId, feedback });
    },

    async gitCommit(proposalId: string, files: string[], message: string) {
      postToNative({ type: 'interactive_response', action: 'gitCommit', proposalId, files, message });
      return { success: true, pending: true };
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
  try {
    (window as any).webkit?.messageHandlers?.bridge?.postMessage({
      type: 'js_error',
      message: `[${label}] ${msg}`,
      url: 'transcript/main.tsx',
      line: 0,
      col: 0,
      stack: error instanceof Error ? error.stack || '' : '',
    });
  } catch {
    // Not in WKWebView
  }
}

function isBenignWindowErrorMessage(message: string): boolean {
  return message === 'ResizeObserver loop completed with undelivered notifications.';
}

// Detailed error capture -- runs BEFORE React mounts so we catch bundle-eval
// errors too. Uses addEventListener (not window.onerror) so we co-exist with
// the native-injected cross-origin-sanitizing handler and can read the real
// Error object from the event.
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
      (window as any).webkit?.messageHandlers?.bridge?.postMessage({
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
      (window as any).webkit?.messageHandlers?.bridge?.postMessage({
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
  // Not in WKWebView
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
// Transcript App
// ============================================================================

function TranscriptApp() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rawMessages, setRawMessages] = useState<BridgeMessage[]>([]);
  const [metadata, setMetadata] = useState<BridgeMetadataUpdate>({});
  const rawMessagesRef = useRef<BridgeMessage[]>([]);
  const viewMessagesRef = useRef<TranscriptViewMessage[]>([]);
  const transcriptRef = useRef<{ scrollToMessage: (index: number) => void; scrollToTop: () => void }>(null);
  const sessionDataRef = useRef<SessionData | null>(null);

  // Track sessionId in a ref so clearSession can access it without re-running the effect
  const sessionIdRef = useRef<string | null>(null);

  // Set up the bridge on window.nimbalyst - runs once on mount, never re-runs
  useEffect(() => {
    // Swift sets window.__nimbalystDebug = true via WKUserScript in DEBUG
    // builds. Release builds leave it unset, so the diagnostic methods below
    // are stripped from the bridge.
    const isDebugBuild = (window as any).__nimbalystDebug === true;

    const nimbalyst: Record<string, unknown> = {
      loadSession(data: BridgeSessionData) {
        try {
          // Clean up previous session's widget host
          if (sessionIdRef.current) {
            setInteractiveWidgetHost(sessionIdRef.current, null);
          }
          sessionIdRef.current = data.sessionId;

          setSessionId(data.sessionId);
          setRawMessages(data.messages || []);
          rawMessagesRef.current = data.messages || [];
          setMetadata(data.metadata || {});

          // Set up interactive widget host for this session
          const host = createMobileBridgeHost(data.sessionId);
          setInteractiveWidgetHost(data.sessionId, host);
        } catch (e) {
          postErrorToNative('loadSession', e);
        }
      },

      appendMessage(message: BridgeMessage) {
        const updated = [...rawMessagesRef.current, message];
        rawMessagesRef.current = updated;
        setRawMessages(updated);
      },

      appendMessages(messages: BridgeMessage[]) {
        if (messages.length === 0) return;
        const updated = [...rawMessagesRef.current, ...messages];
        rawMessagesRef.current = updated;
        setRawMessages(updated);
      },

      updateMetadata(update: BridgeMetadataUpdate) {
        setMetadata((prev) => ({ ...prev, ...update }));
      },

      clearSession() {
        if (sessionIdRef.current) {
          setInteractiveWidgetHost(sessionIdRef.current, null);
          sessionIdRef.current = null;
        }
        setSessionId(null);
        setRawMessages([]);
        rawMessagesRef.current = [];
        setMetadata({});
      },

      scrollToTop() {
        transcriptRef.current?.scrollToTop();
      },

      scrollToMessage(messageId: string) {
        // messageId is actually a UI message index (stringified) from getPromptList
        const index = parseInt(messageId, 10);
        if (!isNaN(index)) {
          transcriptRef.current?.scrollToMessage(index);
        }
      },

      getPromptList(): Array<{ id: string; text: string; createdAt: number }> {
        // Use transformed UI messages (same as desktop PromptMarker extraction)
        // so that the returned indices match the VList item positions.
        const messages = sessionDataRef.current?.messages;
        if (!messages) return [];
        return messages
          .map((msg, index) => ({ msg, index }))
          .filter(({ msg }) => msg.type === 'user_message')
          .map(({ msg, index }) => ({
            id: String(index),
            text: (msg.text || '').substring(0, 80),
            createdAt: msg.createdAt?.getTime() || 0,
          }));
      },
    };

    if (isDebugBuild) {
      // Diagnostics for Safari Web Inspector console. Only attached in DEBUG
      // builds (Swift sets window.__nimbalystDebug via WKUserScript).
      nimbalyst._debugRaw = () => {
        return rawMessagesRef.current.map((m) => {
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
      };
      nimbalyst._debugView = () => {
        return viewMessagesRef.current.map((m) => ({
          type: m.type,
          toolName: (m as any).toolCall?.toolName,
          textPreview: m.text ? m.text.slice(0, 60) : undefined,
        }));
      };
    }

    (window as any).nimbalyst = nimbalyst;

    // Signal to Swift that the bridge is ready
    try {
      (window as any).webkit?.messageHandlers?.bridge?.postMessage({ type: 'ready' });
    } catch {
      // Not in WKWebView (dev mode)
    }

    return () => {
      delete (window as any).nimbalyst;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Transform raw bridge messages to UI format via the canonical transcript
  // pipeline (per-provider parser -> in-memory projector). Async because the
  // parsers return Promises, even when backed by an in-memory store.
  const [viewMessages, setViewMessages] = useState<TranscriptViewMessage[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setViewMessages([]);
      return;
    }
    let cancelled = false;
    try {
      const provider = metadata.provider || 'claude-code';
      const rawForTransform: RawMessage[] = rawMessages.map((m, i) => bridgeMessageToRaw(m, i + 1));
      projectRawMessagesToViewMessages(rawForTransform, provider)
        .then((vms) => {
          if (cancelled) return;
          try {
            viewMessagesRef.current = vms;
            setViewMessages(vms);
          } catch (e) {
            postErrorToNative('projectRawMessages:setState', e);
          }
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
  }, [sessionId, rawMessages, metadata.provider]);

  const sessionData: SessionData | null = React.useMemo(() => {
    if (!sessionId) return null;

    let sessionStatus: string | undefined;
    if (metadata.isExecuting) {
      sessionStatus = 'running';
    }

    return {
      id: sessionId,
      provider: metadata.provider || 'unknown',
      model: metadata.model,
      mode: metadata.mode as 'planning' | 'agent' | undefined,
      messages: viewMessages,
      title: metadata.title,
      createdAt: rawMessages[0]?.createdAt || Date.now(),
      updatedAt: rawMessages[rawMessages.length - 1]?.createdAt || Date.now(),
      metadata: sessionStatus ? { sessionStatus } : undefined,
    };
  }, [sessionId, rawMessages, metadata, viewMessages]);

  // Keep ref in sync so the bridge's getPromptList can access transformed messages
  sessionDataRef.current = sessionData;

  const handleCompact = useCallback(() => {
    try {
      (window as any).webkit?.messageHandlers?.bridge?.postMessage({ type: 'prompt', text: '/compact' });
    } catch (e) {
      console.warn('Failed to send compact command to native:', e);
    }
  }, []);

  const handleOpenFile = useCallback((filePath: string) => {
    try {
      (window as any).webkit?.messageHandlers?.bridge?.postMessage({
        type: 'open_file',
        filePath,
      });
    } catch (e) {
      console.warn('Failed to send open_file to native:', e);
    }
  }, []);

  if (!sessionId || !sessionData) {
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
    <AgentTranscriptPanel
      ref={transcriptRef}
      key={sessionId}
      sessionId={sessionId}
      sessionData={sessionData}
      hideSidebar={true}
      onCompact={handleCompact}
      onFileClick={handleOpenFile}
    />
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
