import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  type VirtualElement,
} from '@floating-ui/react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { AIInput, type AIInputRef } from './AIInput';
import { expandSessionMentions } from './sessionMentions';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { createNewSessionActionAtom } from '../../store/actions/sessionHistoryActions';
import { sessionLaunchPopupRequestAtom } from '../../store/atoms/appCommands';
import {
  defaultAgentModelAtom,
  defaultEffortLevelAtom,
  developerModeAtom,
  setAgentModeSettingsAtom,
} from '../../store/atoms/appSettings';
import {
  createEmptySessionLaunchDraft,
  sessionLaunchDraftAtom,
} from '../../store/atoms/sessionLaunchPopup';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import {
  parseThinkingMode,
  supportsEffortLevel,
  supportsThinkingToggle,
  type EffortLevel,
  type ThinkingMode,
} from '../../utils/modelUtils';
import { isClaudeCliTerminalSession } from './claudeCliInputRouting';

interface SessionLaunchPopupProps {
  workspacePath: string | null;
}

interface LaunchPromptOptions {
  sessionId: string;
  workspacePath: string;
  provider: string;
  model: string;
  prompt: string;
  mode: 'agent' | 'planning';
  attachments: ChatAttachment[];
}

interface DragStart {
  pointerId: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
}

/** Route the first turn through the same provider-specific seam as SessionTranscript. */
export async function launchSessionPrompt({
  sessionId,
  workspacePath,
  provider,
  model,
  prompt,
  mode,
  attachments,
}: LaunchPromptOptions): Promise<void> {
  if (isClaudeCliTerminalSession(provider)) {
    const ensured = await window.electronAPI.terminal.ensureClaudeCliSession({
      sessionId,
      workspacePath,
      model,
    });
    if (!ensured.success) {
      throw new Error(
        ensured.claudeNotInstalled
          ? 'Claude Code CLI is not installed.'
          : ensured.error || 'Failed to start the Claude Code CLI session.',
      );
    }
    const result = await window.electronAPI.terminal.submitClaudeCliPrompt({
      sessionId,
      workspacePath,
      prompt,
      attachments,
    });
    if (!result.success) throw new Error('Failed to submit the Claude Code CLI prompt.');
    return;
  }

  const result = await window.electronAPI.invoke(
    'ai:sendMessage',
    prompt,
    {
      attachments: attachments.length > 0 ? attachments : undefined,
      mode,
      inputType: 'user',
    },
    sessionId,
    workspacePath,
  );
  if (result?.success === false) {
    throw new Error(result.error || 'Failed to start the session.');
  }
}

export const SessionLaunchPopup: React.FC<SessionLaunchPopupProps> = ({ workspacePath }) => {
  const requestVersion = useAtomValue(sessionLaunchPopupRequestAtom);
  const requestVersionRef = useRef(requestVersion);
  const workspaceKey = workspacePath ?? '';
  const draftAtom = useMemo(() => sessionLaunchDraftAtom(workspaceKey), [workspaceKey]);
  const [draft, setDraft] = useAtom(draftAtom);
  const defaultModel = useAtomValue(defaultAgentModelAtom);
  const defaultEffortLevel = useAtomValue(defaultEffortLevelAtom);
  const developerMode = useAtomValue(developerModeAtom);
  const sessionRegistry = useAtomValue(sessionRegistryAtom);
  const setAgentModeSettings = useSetAtom(setAgentModeSettingsAtom);
  const createNewSession = useSetAtom(createNewSessionActionAtom);
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<AIInputRef>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const dragStartRef = useRef<DragStart | null>(null);

  const selectedModel = draft.model ?? defaultModel;
  const parsedModel = selectedModel ? ModelIdentifier.tryParse(selectedModel) : null;
  const provider = parsedModel?.provider ?? 'claude-code';
  const effortLevel = draft.effortLevel ?? defaultEffortLevel;
  const thinkingMode = draft.thinkingMode ?? parseThinkingMode(undefined);

  const virtualReference = useMemo<VirtualElement>(() => ({
    getBoundingClientRect: () => DOMRect.fromRect({
      x: window.innerWidth / 2 + dragOffset.x,
      y: window.innerHeight - 28 + dragOffset.y,
      width: 0,
      height: 0,
    }),
  }), [dragOffset]);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top',
    strategy: 'fixed',
    middleware: [offset(16), shift({ padding: 16 })],
    whileElementsMounted: autoUpdate,
  });
  const dismiss = useDismiss(context, { outsidePress: false });
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  useEffect(() => {
    refs.setPositionReference(virtualReference);
    return () => refs.setPositionReference(null);
  }, [refs, virtualReference]);

  const ensurePendingSessionId = useCallback(() => {
    if (draft.pendingSessionId) return;
    setDraft((current) => ({
      ...current,
      pendingSessionId: current.pendingSessionId ?? crypto.randomUUID(),
    }));
  }, [draft.pendingSessionId, setDraft]);

  useEffect(() => {
    if (requestVersion === requestVersionRef.current) return;
    requestVersionRef.current = requestVersion;
    if (!workspacePath) return;
    setError(null);
    setOpen((wasOpen) => {
      if (!wasOpen) ensurePendingSessionId();
      return !wasOpen;
    });
  }, [requestVersion, workspacePath, ensurePendingSessionId]);

  useEffect(() => {
    if (!open) return;
    ensurePendingSessionId();
  }, [open, ensurePendingSessionId]);

  useEffect(() => {
    let frame: number | undefined;
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      frame = requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected) frame = requestAnimationFrame(() => previous.focus());
    }
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setCreatedSessionId(null);
    setError(null);
    setDragOffset({ x: 0, y: 0 });
    setIsDragging(false);
    dragStartRef.current = null;
  }, [workspacePath]);

  const handleTitlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
    dragStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: dragOffset.x,
      offsetY: dragOffset.y,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsDragging(true);
    event.preventDefault();
  }, [dragOffset]);

  const handleTitlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setDragOffset({
      x: start.offsetX + event.clientX - start.clientX,
      y: start.offsetY + event.clientY - start.clientY,
    });
  }, []);

  const finishTitleDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStartRef.current = null;
    setIsDragging(false);
  }, []);

  const updateValue = useCallback((value: string) => {
    setDraft((current) => ({ ...current, value }));
  }, [setDraft]);

  const addAttachment = useCallback((attachment: ChatAttachment) => {
    setDraft((current) => ({
      ...current,
      attachments: [...current.attachments, attachment],
    }));
  }, [setDraft]);

  const removeAttachment = useCallback((attachmentId: string) => {
    setDraft((current) => ({
      ...current,
      attachments: current.attachments.filter((attachment) => attachment.id !== attachmentId),
    }));
  }, [setDraft]);

  const handleModelChange = useCallback((model: string) => {
    setDraft((current) => ({ ...current, model }));
    setAgentModeSettings({ defaultModel: model });
  }, [setDraft, setAgentModeSettings]);

  const handleEffortLevelChange = useCallback((nextEffort: EffortLevel) => {
    setDraft((current) => ({ ...current, effortLevel: nextEffort }));
    setAgentModeSettings({ defaultEffortLevel: nextEffort });
  }, [setDraft, setAgentModeSettings]);

  const handleThinkingModeChange = useCallback((nextThinkingMode: ThinkingMode) => {
    setDraft((current) => ({ ...current, thinkingMode: nextThinkingMode }));
  }, [setDraft]);

  const handleSend = useCallback(async () => {
    let prompt = draft.value.trim();
    if (!prompt || !workspacePath || !draft.pendingSessionId || !selectedModel || isSubmitting) return;

    let launchMode = draft.mode;
    const planCommand = prompt.match(/^\/plan(?:\s|$)/);
    if (planCommand) {
      launchMode = 'planning';
      prompt = prompt.slice(planCommand[0].length).trim();
      if (!prompt) {
        setError('Add instructions after /plan before starting the session.');
        return;
      }
    }

    prompt = expandSessionMentions(prompt, sessionRegistry);
    setIsSubmitting(true);
    setError(null);

    try {
      let sessionId = createdSessionId;
      if (!sessionId) {
        sessionId = await createNewSession({
          sessionId: draft.pendingSessionId,
          model: selectedModel,
          mode: launchMode,
          selectSession: false,
          metadata: {
            effortLevel,
            thinkingMode,
          },
        }) ?? null;
        if (!sessionId) throw new Error('Failed to create the session.');
        setCreatedSessionId(sessionId);
      }

      const backgroundLaunch = launchSessionPrompt({
        sessionId,
        workspacePath,
        provider,
        model: selectedModel,
        prompt,
        mode: launchMode,
        attachments: draft.attachments,
      });

      setDraft(createEmptySessionLaunchDraft());
      setCreatedSessionId(null);
      setOpen(false);

      void backgroundLaunch.catch((backgroundError) => {
        console.error('[SessionLaunchPopup] Background session failed:', backgroundError);
        errorNotificationService.showError(
          'Background session failed',
          backgroundError instanceof Error ? backgroundError.message : 'Failed to start the session.',
        );
      });
    } catch (launchError) {
      console.error('[SessionLaunchPopup] Failed to launch session:', launchError);
      setError(launchError instanceof Error ? launchError.message : 'Failed to start the session.');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    createNewSession,
    createdSessionId,
    draft,
    effortLevel,
    isSubmitting,
    provider,
    selectedModel,
    sessionRegistry,
    setDraft,
    thinkingMode,
    workspacePath,
  ]);

  if (!open || !workspacePath) return null;

  return (
    <FloatingPortal>
      <div
        className="session-launch-popup-backdrop fixed inset-0 z-[900] bg-[var(--nim-bg)] opacity-20"
        aria-hidden="true"
        onClick={() => setOpen(false)}
      />
      <div
        ref={refs.setFloating}
        style={{
          ...floatingStyles,
          width: 'min(720px, calc(100vw - 32px))',
        }}
        className="session-launch-popup z-[901] overflow-hidden rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-2xl"
        aria-label="Launch new session"
        data-drag-offset-x={dragOffset.x}
        data-drag-offset-y={dragOffset.y}
        {...getFloatingProps()}
      >
        <div
          className={`session-launch-popup-titlebar flex h-9 items-center justify-between border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 text-xs font-medium text-[var(--nim-text)] ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ touchAction: 'none', userSelect: 'none' }}
          onPointerDown={handleTitlePointerDown}
          onPointerMove={handleTitlePointerMove}
          onPointerUp={finishTitleDrag}
          onPointerCancel={finishTitleDrag}
        >
          <span>Launch New Session</span>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--nim-text-muted)] transition-colors hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--nim-border-focus)]"
            aria-label="Close session launch popup"
            onClick={() => setOpen(false)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <AIInput
          ref={inputRef}
          value={draft.value}
          onChange={updateValue}
          onSend={() => void handleSend()}
          disabled={isSubmitting}
          isLoading={isSubmitting}
          placeholder="Ask or instruct..."
          workspacePath={workspacePath}
          sessionId={draft.pendingSessionId ?? undefined}
          attachments={draft.attachments}
          onAttachmentAdd={addAttachment}
          onAttachmentRemove={removeAttachment}
          enableSlashCommands
          mode={draft.mode}
          onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
          currentModel={selectedModel}
          onModelChange={createdSessionId ? undefined : handleModelChange}
          readOnlyModel={Boolean(createdSessionId)}
          readOnlyModelTitle="This session was already created; retry to submit the prompt"
          sessionHasMessages={false}
          currentProvider={provider}
          effortLevel={effortLevel}
          onEffortLevelChange={handleEffortLevelChange}
          showEffortLevel={supportsEffortLevel(selectedModel)}
          thinkingMode={thinkingMode}
          onThinkingModeChange={handleThinkingModeChange}
          showThinkingToggle={developerMode && supportsThinkingToggle(selectedModel)}
          provider={provider}
          testId="session-launch-popup-input"
        />
        {error && (
          <div className="session-launch-popup-error select-text border-t border-[var(--nim-border)] px-3 py-2 text-xs text-[var(--nim-error)]" role="alert">
            {error}
          </div>
        )}
      </div>
    </FloatingPortal>
  );
};

export default SessionLaunchPopup;
