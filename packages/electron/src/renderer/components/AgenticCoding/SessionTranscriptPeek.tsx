import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type Placement,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { RichTranscriptView } from '@nimbalyst/runtime/ui/AgentTranscript/components/RichTranscriptView';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import { getCardType } from '../../store/atoms/sessionKanban';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { transcriptEventSignalAtom } from '../../store/atoms/sessionTranscript';

const tailMessageCache = new Map<string, TranscriptViewMessage[]>();

const PEEK_SETTINGS = {
  showToolCalls: true,
  compactMode: true,
  collapseTools: true,
  showThinking: false,
  showSessionInit: false,
};

export interface SessionTranscriptPeekProps {
  sessionId: string;
  reference: HTMLElement | null;
  placement?: Placement;
  onClose: () => void;
}

/**
 * Shared live transcript preview for secondary session surfaces.
 *
 * The preview always refreshes on mount, then follows centralized transcript
 * activity signals while open. It deliberately does not persist scroll state,
 * so it cannot change the main transcript's follow-at-bottom behavior.
 */
export function SessionTranscriptPeek({
  sessionId,
  reference,
  placement = 'bottom-start',
  onClose,
}: SessionTranscriptPeekProps) {
  const registry = useAtomValue(sessionRegistryAtom);
  const resolvedSessionId = useMemo(() => {
    const meta = registry.get(sessionId);
    if (!meta || getCardType(meta) === 'session') return sessionId;

    let bestId = sessionId;
    let bestUpdatedAt = -Infinity;
    for (const child of registry.values()) {
      if (child.parentSessionId !== sessionId) continue;
      const updatedAt = child.updatedAt ?? 0;
      if (updatedAt > bestUpdatedAt) {
        bestUpdatedAt = updatedAt;
        bestId = child.id;
      }
    }
    return bestId;
  }, [registry, sessionId]);

  const [messages, setMessages] = useState<TranscriptViewMessage[] | null>(
    tailMessageCache.get(resolvedSessionId) ?? null,
  );
  const [loading, setLoading] = useState(!tailMessageCache.has(resolvedSessionId));
  const fetchGenerationRef = useRef(0);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) onClose();
  }, [onClose]);

  const floating = useFloating({
    open: true,
    onOpenChange: handleOpenChange,
    placement,
    strategy: 'fixed',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      windowControlsClearance(),
    ],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useLayoutEffect(() => {
    floating.refs.setReference(reference);
  }, [floating.refs, reference]);

  useEffect(() => {
    if (reference && !reference.isConnected) {
      onClose();
    }
  }, [onClose, reference]);

  const fetchMessages = useCallback(async (id: string) => {
    const generation = ++fetchGenerationRef.current;
    try {
      const nextMessages = await window.electronAPI.ai.getTailMessages(id, 100) as TranscriptViewMessage[];
      if (generation !== fetchGenerationRef.current) return;
      tailMessageCache.set(id, nextMessages);
      setMessages(nextMessages);
      setLoading(false);
    } catch {
      if (generation !== fetchGenerationRef.current) return;
      setMessages((previous) => previous ?? []);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const cached = tailMessageCache.get(resolvedSessionId);
    if (cached) {
      setMessages(cached);
      setLoading(false);
    } else {
      setMessages(null);
      setLoading(true);
    }
    void fetchMessages(resolvedSessionId);
    return () => {
      fetchGenerationRef.current += 1;
    };
  }, [fetchMessages, resolvedSessionId]);

  const transcriptSignal = useAtomValue(transcriptEventSignalAtom(resolvedSessionId));
  const initialTranscriptSignalRef = useRef({
    sessionId: resolvedSessionId,
    value: transcriptSignal,
  });
  useEffect(() => {
    if (initialTranscriptSignalRef.current.sessionId !== resolvedSessionId) {
      initialTranscriptSignalRef.current = {
        sessionId: resolvedSessionId,
        value: transcriptSignal,
      };
      return;
    }
    if (transcriptSignal === initialTranscriptSignalRef.current.value) return;

    const debounceTimer = window.setTimeout(() => {
      tailMessageCache.delete(resolvedSessionId);
      void fetchMessages(resolvedSessionId);
    }, 1_500);
    return () => window.clearTimeout(debounceTimer);
  }, [fetchMessages, resolvedSessionId, transcriptSignal]);

  return (
    <FloatingPortal>
      <div
        ref={floating.refs.setFloating}
        style={{
          ...floating.floatingStyles,
          width: 'min(600px, calc(100vw - 16px))',
          height: 'min(350px, calc(100vh - 16px))',
        }}
        {...getFloatingProps()}
        className="session-transcript-peek z-[10010] flex overflow-hidden rounded-lg border border-nim bg-nim-secondary shadow-2xl"
        data-session-transcript-peek
        data-testid="session-transcript-peek"
        data-session-id={resolvedSessionId}
        onMouseLeave={onClose}
      >
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-nim-faint">
            <span className="material-symbols-outlined animate-spin text-sm" style={{ fontSize: '16px' }}>
              progress_activity
            </span>
          </div>
        ) : messages && messages.length > 0 ? (
          <div className="flex-1 overflow-hidden">
            <RichTranscriptView
              sessionId={resolvedSessionId}
              messages={messages}
              settings={PEEK_SETTINGS}
              persistScrollState={false}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[11px] italic text-nim-disabled">
            No messages yet
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}
