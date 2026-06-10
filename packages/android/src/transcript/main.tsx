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

const BARE_EXECUTING_FALLBACK_MS = 20_000;

// ============================================================================
// Types for Swift <-> JS bridge
// ============================================================================

interface BridgeSessionData {
  sessionId: string;
  messages: BridgeMessage[];
  /**
   * Pre-projected transcript tail for oversized sessions whose per-message sync
   * was disabled by the server (message_limit_exceeded / message_too_large). The
   * desktop publishes the last N projected view-messages in the encrypted index
   * metadata; when present we render these directly and skip raw projection.
   */
  viewMessages?: TranscriptViewMessage[];
  /**
   * One cursor-based projected history page returned by desktop after mobile
   * asks for older transcript rows.
   */
  historyPage?: MobileTranscriptHistoryPage;
  metadata: {
    title?: string;
    provider?: string;
    model?: string;
    mode?: string;
    isExecuting?: boolean;
    agentStatus?: BridgeAgentStatus;
  };
}

interface BridgeAgentStatus {
  kind?: string | null;
  label?: string | null;
  detail?: string | null;
  updatedAt?: number | null;
}

interface MobileTranscriptHistoryPage {
  version: 1;
  sessionId: string;
  requestId?: string;
  beforeRawMessageId: number | null;
  rawStartId: number | null;
  rawEndId: number | null;
  rawMessageCount?: number;
  projectedMessageCount?: number;
  hasMoreBefore: boolean;
  messages: TranscriptViewMessage[];
}

interface HistoryCursor {
  rawStartId: number | null;
  hasMoreBefore: boolean;
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
  agentStatus?: BridgeAgentStatus;
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

    const webkitBridge = (window as any).webkit?.messageHandlers?.bridge;
    if (webkitBridge?.postMessage) {
      webkitBridge.postMessage(message);
      return;
    }
  } catch (e) {
    console.warn('Failed to post to native:', e);
  }
}

function rehydrateViewMessage<T extends TranscriptViewMessage>(message: T): T {
  return {
    ...message,
    createdAt: message.createdAt instanceof Date
      ? message.createdAt
      : new Date(message.createdAt as unknown as number),
  };
}

function viewMessageKey(message: TranscriptViewMessage): string {
  const anyMessage = message as any;
  const createdAt = message.createdAt instanceof Date
    ? message.createdAt.getTime()
    : Number(message.createdAt ?? 0);
  const stableId = anyMessage.id ?? anyMessage.messageId ?? anyMessage.toolCall?.id ?? anyMessage.toolCall?.callId;
  if (stableId) return `${message.type}:id:${stableId}`;

  const text = String(
    anyMessage.text ??
    anyMessage.thinking ??
    anyMessage.toolCall?.description ??
    anyMessage.toolCall?.result ??
    ''
  ).slice(0, 200);
  return `${message.type}:${createdAt}:${text}`;
}

function mergeViewMessages(...groups: TranscriptViewMessage[][]): TranscriptViewMessage[] {
  const seen = new Set<string>();
  const merged: TranscriptViewMessage[] = [];
  for (const group of groups) {
    for (const message of group) {
      const key = viewMessageKey(message);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(message);
    }
  }
  return merged;
}

function getTranscriptScroller(): HTMLElement | null {
  return document.querySelector('.rich-transcript-vlist') as HTMLElement | null;
}

function normalizeAgentStatusKind(metadata: BridgeMetadataUpdate): string | undefined {
  return metadata.agentStatus?.kind?.toLowerCase() || undefined;
}

function hasExplicitAgentStatus(metadata: BridgeMetadataUpdate): boolean {
  const status = metadata.agentStatus;
  return !!(
    status?.kind?.trim() ||
    status?.label?.trim() ||
    status?.detail?.trim()
  );
}

function isTerminalAgentStatusKind(kind: string | undefined): boolean {
  return kind === 'complete' || kind === 'completed' || kind === 'done' || kind === 'idle';
}

function getAgentStatusLabel(
  metadata: BridgeMetadataUpdate,
  bareExecutingFallbackActive = true,
): string | undefined {
  if (!shouldShowBottomAgentStatus(metadata, bareExecutingFallbackActive)) return undefined;

  const explicitLabel = metadata.agentStatus?.label?.trim();
  if (explicitLabel) return explicitLabel;

  const kind = normalizeAgentStatusKind(metadata);
  const detail = metadata.agentStatus?.detail?.trim();
  switch (kind) {
    case 'thinking':
      return 'Thinking...';
    case 'responding':
      return 'Responding...';
    case 'tool':
      return detail ? `Using ${detail}...` : 'Using tool...';
    case 'editing':
      return 'Editing file...';
    case 'waiting':
      return 'Waiting for your response';
    case 'queued':
      return 'Prompt queued on desktop';
    case 'error':
      return 'Agent hit an error';
    default:
      return metadata.isExecuting ? 'Thinking...' : undefined;
  }
}

function shouldShowBottomAgentStatus(
  metadata: BridgeMetadataUpdate,
  bareExecutingFallbackActive = true,
): boolean {
  const kind = normalizeAgentStatusKind(metadata);
  if (isTerminalAgentStatusKind(kind)) return false;

  if (hasExplicitAgentStatus(metadata)) {
    return kind === 'thinking' ||
      kind === 'responding' ||
      kind === 'tool' ||
      kind === 'editing' ||
      kind === 'waiting' ||
      kind === 'queued' ||
      kind === 'error' ||
      metadata.isExecuting === true;
  }

  // Older desktop builds only send a bare isExecuting=true flag. Use it as a
  // short-lived fallback so a missed completion event cannot pin "Thinking..."
  // forever after the finished transcript text has arrived.
  return metadata.isExecuting === true && bareExecutingFallbackActive;
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
      postToNative({ type: 'interactive_response', action: 'askUserQuestionSubmit', questionId, answers });
    },

    async requestUserInputSubmit(promptId: string, answers: Record<string, any>) {
      postToNative({ type: 'interactive_response', action: 'requestUserInputSubmit', promptId, answers });
    },

    async requestUserInputCancel(promptId: string) {
      postToNative({
        type: 'interactive_response',
        action: 'requestUserInputCancel',
        promptId,
        answers: {},
        cancelled: true,
      });
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

    async gitCommitCancel(proposalId: string) {
      postToNative({ type: 'interactive_response', action: 'gitCommitCancel', proposalId });
    },

    async askUserQuestionCancel(questionId: string) {
      postToNative({ type: 'interactive_response', action: 'askUserQuestionCancel', questionId });
    },

    async exitPlanModeStartNewSession(requestId: string, planFilePath: string) {
      postToNative({ type: 'interactive_response', action: 'exitPlanModeStartNewSession', requestId, planFilePath });
    },

    async exitPlanModeCancel(requestId: string) {
      postToNative({ type: 'interactive_response', action: 'exitPlanModeCancel', requestId });
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
  // Pre-projected tail messages (oversized sessions); null = project rawMessages.
  const [providedViewMessages, setProvidedViewMessages] = useState<TranscriptViewMessage[] | null>(null);
  const [metadata, setMetadata] = useState<BridgeMetadataUpdate>({});
  const [historyViewMessages, setHistoryViewMessages] = useState<TranscriptViewMessage[]>([]);
  const [historyCursor, setHistoryCursor] = useState<HistoryCursor>({ rawStartId: null, hasMoreBefore: true });
  const [historyLoading, setHistoryLoading] = useState(false);
  const rawMessagesRef = useRef<BridgeMessage[]>([]);
  const transcriptRef = useRef<{ scrollToMessage: (index: number) => void; scrollToTop: () => void }>(null);
  const sessionDataRef = useRef<SessionData | null>(null);
  const historyCursorRef = useRef<HistoryCursor>({ rawStartId: null, hasMoreBefore: true });
  const historyLoadingRef = useRef(false);
  const requestedHistoryBeforeRef = useRef<Set<string>>(new Set());
  const loadingHistoryKeyRef = useRef<string | null>(null);
  const lastAppliedHistoryPageKeyRef = useRef<string | null>(null);
  const [bareExecutingFallbackUntil, setBareExecutingFallbackUntil] = useState(0);
  const [, setBareExecutingFallbackTick] = useState(0);

  // Track sessionId in a ref so clearSession can access it without re-running the effect
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    historyCursorRef.current = historyCursor;
  }, [historyCursor]);

  useEffect(() => {
    historyLoadingRef.current = historyLoading;
  }, [historyLoading]);

  const requestOlderHistory = useCallback(() => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;

    const cursor = historyCursorRef.current;
    if (!cursor.hasMoreBefore && cursor.rawStartId !== null) return;
    if (historyLoadingRef.current) return;

    const beforeRawMessageId = cursor.rawStartId;
    const historyKey = beforeRawMessageId == null ? 'latest' : String(beforeRawMessageId);
    if (requestedHistoryBeforeRef.current.has(historyKey)) return;

    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    requestedHistoryBeforeRef.current.add(historyKey);
    loadingHistoryKeyRef.current = historyKey;
    historyLoadingRef.current = true;
    setHistoryLoading(true);
    postToNative({
      type: 'load_older_history',
      requestId,
      beforeRawMessageId,
      count: 240,
    });

    window.setTimeout(() => {
      if (loadingHistoryKeyRef.current !== historyKey) return;
      loadingHistoryKeyRef.current = null;
      historyLoadingRef.current = false;
      requestedHistoryBeforeRef.current.delete(historyKey);
      setHistoryLoading(false);
    }, 15000);
  }, []);

  const resetHistoryState = useCallback(() => {
    setHistoryViewMessages([]);
    setHistoryCursor({ rawStartId: null, hasMoreBefore: true });
    historyCursorRef.current = { rawStartId: null, hasMoreBefore: true };
    historyLoadingRef.current = false;
    setHistoryLoading(false);
    requestedHistoryBeforeRef.current.clear();
    loadingHistoryKeyRef.current = null;
    lastAppliedHistoryPageKeyRef.current = null;
  }, []);

  const applyHistoryPage = useCallback((page?: MobileTranscriptHistoryPage | null) => {
    if (!page || page.sessionId !== sessionIdRef.current) return;

    const pageKey = `${page.requestId ?? ''}:${page.rawStartId ?? 'none'}:${page.rawEndId ?? 'none'}:${page.projectedMessageCount ?? page.messages.length}`;
    if (lastAppliedHistoryPageKeyRef.current === pageKey) {
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      return;
    }
    lastAppliedHistoryPageKeyRef.current = pageKey;

    const scroller = getTranscriptScroller();
    const previousScrollHeight = scroller?.scrollHeight ?? null;
    const pageMessages = (page.messages || []).map(rehydrateViewMessage);

    setHistoryCursor({
      rawStartId: page.rawStartId,
      hasMoreBefore: page.hasMoreBefore,
    });
    historyCursorRef.current = {
      rawStartId: page.rawStartId,
      hasMoreBefore: page.hasMoreBefore,
    };

    setHistoryViewMessages((previous) => mergeViewMessages(pageMessages, previous));

    loadingHistoryKeyRef.current = null;
    historyLoadingRef.current = false;
    setHistoryLoading(false);

    if (previousScrollHeight != null) {
      requestAnimationFrame(() => {
        const updatedScroller = getTranscriptScroller();
        if (!updatedScroller) return;
        const delta = updatedScroller.scrollHeight - previousScrollHeight;
        if (delta > 0) {
          updatedScroller.scrollTop += delta;
        }
      });
    }
  }, []);

  // Set up the bridge on window.nimbalyst - runs once on mount, never re-runs
  useEffect(() => {
    const nimbalyst = {
      loadSession(data: BridgeSessionData) {
        try {
          const previousSessionId = sessionIdRef.current;
          const isSameSession = previousSessionId === data.sessionId;

          // Clean up previous session's widget host
          if (previousSessionId && !isSameSession) {
            setInteractiveWidgetHost(previousSessionId, null);
          }
          if (!isSameSession) {
            resetHistoryState();
          }
          sessionIdRef.current = data.sessionId;

          setSessionId(data.sessionId);
          setRawMessages(data.messages || []);
          rawMessagesRef.current = data.messages || [];
          setProvidedViewMessages(data.viewMessages ?? null);
          setMetadata(data.metadata || {});
          applyHistoryPage(data.historyPage ?? null);

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

      applyHistoryPage(page: MobileTranscriptHistoryPage) {
        try {
          applyHistoryPage(page);
        } catch (e) {
          postErrorToNative('applyHistoryPage', e);
        }
      },

      clearSession() {
        if (sessionIdRef.current) {
          setInteractiveWidgetHost(sessionIdRef.current, null);
          sessionIdRef.current = null;
        }
        setSessionId(null);
        setRawMessages([]);
        rawMessagesRef.current = [];
        setProvidedViewMessages(null);
        resetHistoryState();
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

    (window as any).nimbalyst = nimbalyst;

    postToNative({ type: 'ready' });

    return () => {
      delete (window as any).nimbalyst;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Transform raw bridge messages to UI format via the canonical transcript
  // pipeline (per-provider parser -> in-memory projector). Async because the
  // parsers return Promises, even when backed by an in-memory store.
  const [baseViewMessages, setBaseViewMessages] = useState<TranscriptViewMessage[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setBaseViewMessages([]);
      return;
    }
    // Oversized sessions: the desktop already projected the tail; render it
    // directly. JSON serialization turns Date -> epoch ms, so rehydrate createdAt.
    if (providedViewMessages) {
      setBaseViewMessages(providedViewMessages.map(rehydrateViewMessage));
      return;
    }
    let cancelled = false;
    const provider = metadata.provider || 'claude-code';
    const rawForTransform: RawMessage[] = rawMessages.map((m, i) => bridgeMessageToRaw(m, i + 1));
    projectRawMessagesToViewMessages(rawForTransform, provider)
      .then((vms) => {
        if (!cancelled) setBaseViewMessages(vms);
      })
      .catch((e) => {
        if (!cancelled) postErrorToNative('projectRawMessages', e);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, rawMessages, metadata.provider, providedViewMessages]);

  const viewMessages = React.useMemo(
    () => mergeViewMessages(historyViewMessages, baseViewMessages),
    [historyViewMessages, baseViewMessages],
  );

  const contentActivityKey = React.useMemo(() => {
    const lastMessage = viewMessages[viewMessages.length - 1];
    return `${sessionId ?? 'none'}:${viewMessages.length}:${lastMessage ? viewMessageKey(lastMessage) : 'empty'}`;
  }, [sessionId, viewMessages]);

  useEffect(() => {
    if (metadata.isExecuting && !hasExplicitAgentStatus(metadata)) {
      setBareExecutingFallbackUntil(Date.now() + BARE_EXECUTING_FALLBACK_MS);
    } else {
      setBareExecutingFallbackUntil(0);
    }
  }, [metadata.isExecuting, metadata.agentStatus, contentActivityKey]);

  useEffect(() => {
    if (bareExecutingFallbackUntil <= 0) return;
    const delayMs = Math.max(0, bareExecutingFallbackUntil - Date.now()) + 50;
    const timer = window.setTimeout(() => {
      setBareExecutingFallbackTick((tick) => tick + 1);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [bareExecutingFallbackUntil]);

  const bareExecutingFallbackActive = bareExecutingFallbackUntil > Date.now();
  const bottomAgentStatusActive = shouldShowBottomAgentStatus(metadata, bareExecutingFallbackActive);
  const bottomAgentStatusLabel = getAgentStatusLabel(metadata, bareExecutingFallbackActive);

  useEffect(() => {
    if (!sessionId) return;

    let scroller: HTMLElement | null = null;
    let retryTimer: number | null = null;
    let delayedCheckTimer: number | null = null;

    const handleScroll = () => {
      if (!scroller) return;
      if (scroller.scrollTop <= 120) {
        requestOlderHistory();
      }
    };

    const attach = (attempt = 0) => {
      scroller = getTranscriptScroller();
      if (!scroller) {
        if (attempt < 20) {
          retryTimer = window.setTimeout(() => attach(attempt + 1), 100);
        }
        return;
      }

      scroller.addEventListener('scroll', handleScroll, { passive: true });
      delayedCheckTimer = window.setTimeout(handleScroll, 500);
    };

    attach();

    return () => {
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (delayedCheckTimer != null) window.clearTimeout(delayedCheckTimer);
      if (scroller) {
        scroller.removeEventListener('scroll', handleScroll);
      }
    };
  }, [sessionId, viewMessages.length, requestOlderHistory]);

  const sessionData: SessionData | null = React.useMemo(() => {
    if (!sessionId) return null;

    let sessionStatus: string | undefined;
    if (bottomAgentStatusActive) {
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
      metadata: sessionStatus || bottomAgentStatusLabel ? { sessionStatus, agentStatusLabel: bottomAgentStatusLabel } : undefined,
    };
  }, [sessionId, rawMessages, metadata, viewMessages, bottomAgentStatusActive, bottomAgentStatusLabel]);

  // Keep ref in sync so the bridge's getPromptList can access transformed messages
  sessionDataRef.current = sessionData;

  const handleCompact = useCallback(() => {
    postToNative({ type: 'prompt', text: '/compact' });
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
      isProcessing={bottomAgentStatusActive}
      waitingTextOverride={bottomAgentStatusLabel}
      hideSidebar={true}
      onCompact={handleCompact}
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
