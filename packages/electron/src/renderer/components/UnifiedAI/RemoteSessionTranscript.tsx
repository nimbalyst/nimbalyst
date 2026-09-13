import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RichTranscriptView } from "@nimbalyst/runtime/ui/AgentTranscript/components/RichTranscriptView";
import {
  acquireRemoteSession,
  remoteSessionErrorAtom,
  remoteSessionSnapshotAtom,
} from "../../store/listeners/remoteSessionViews";
import {
  sessionDraftInputAtom,
  sessionDraftAttachmentsAtom,
  sessionDraftHydratedAtom,
  sessionDraftLocalModifiedAtAtom,
} from "../../store/atoms/sessions";
import { SessionAIInput } from "./SessionAIInput";
import type { SlashCommandEntry } from "../Typeahead/slashCommandAutocomplete";
import type { AIInputRef } from "./AIInput";
import type { ActionPrompt } from "../../store/atoms/actionPrompts";
import type { ChatAttachment } from "@nimbalyst/runtime/ai/server/types";
import type {
  SessionTranscriptProps,
  SessionTranscriptRef,
} from "./SessionTranscript";

/** Observes the remote transcript and shares the normal composer without a local queue driver. */
export const RemoteSessionTranscript = forwardRef<
  SessionTranscriptRef,
  SessionTranscriptProps
>(({ sessionId, workspacePath }, ref) => {
  const snapshot = useAtomValue(remoteSessionSnapshotAtom(sessionId));
  const connectionError = useAtomValue(remoteSessionErrorAtom(sessionId));
  const [prompt, setPrompt] = useAtom(sessionDraftInputAtom(sessionId));
  const [attachments, setAttachments] = useAtom(
    sessionDraftAttachmentsAtom(sessionId)
  );
  const [hydrated, setHydrated] = useAtom(sessionDraftHydratedAtom(sessionId));
  const modified = useAtomValue(sessionDraftLocalModifiedAtAtom(sessionId));
  const setModified = useSetAtom(sessionDraftLocalModifiedAtAtom(sessionId));
  const loadedDraft = useRef(false);
  const [turnOptions, setTurnOptions] = useState<
    import("@nimbalyst/runtime/sync/types").RemoteTurnOptions
  >({ mode: "agent", effortLevel: "high" });
  const optionsRef = useRef(turnOptions);
  optionsRef.current = turnOptions;
  const updateOptions = (options: Partial<typeof turnOptions>) => {
    setTurnOptions((previous) => ({ ...previous, ...options }));
    setModified(Date.now());
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<{
    files: string[];
    commands: SlashCommandEntry[];
  } | null>(null);
  const input = useRef<AIInputRef>(null);
  const edited = useRef(false);
  useImperativeHandle(ref, () => ({
    focusInput: () => input.current?.focus(),
    insertPrompt: (text) => {
      edited.current = true;
      setPrompt(text);
      setModified(Date.now());
      input.current?.focus();
    },
  }));
  useEffect(() => {
    if (!workspacePath) return;
    return acquireRemoteSession(sessionId, workspacePath);
  }, [sessionId, workspacePath]);
  useEffect(() => {
    if (!workspacePath || (loadedDraft.current && hydrated)) return;
    let cancelled = false;
    void window.electronAPI
      .invoke("ai:loadRemoteDraft", sessionId, workspacePath)
      .then((draft) => {
        if (cancelled) return;
        loadedDraft.current = true;
        if (!edited.current && !latestDraft.current.modified) {
          setPrompt(draft.text ?? "");
          setAttachments(draft.attachments ?? []);
        }
        if (draft.options) setTurnOptions(draft.options);
        setHydrated(true);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, workspacePath, hydrated, setPrompt, setAttachments, setHydrated]);
  useEffect(() => {
    if (
      !snapshot?.connected ||
      !snapshot.hostOnline ||
      snapshot.readOnlyReason ||
      !workspacePath
    )
      return;
    let cancelled = false;
    void window.electronAPI
      .invoke("ai:remoteWorkspaceContext", sessionId, workspacePath)
      .then((value) => {
        if (!cancelled) setContext(value);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
      setContext(null);
    };
  }, [
    sessionId,
    workspacePath,
    snapshot?.connected,
    snapshot?.hostOnline,
    snapshot?.readOnlyReason,
  ]);
  const persistDraft = useCallback(
    async (text: string, files: ChatAttachment[]) => {
      await window.electronAPI.invoke(
        "ai:saveRemoteDraft",
        sessionId,
        workspacePath,
        { text, attachments: files, options: optionsRef.current }
      );
    },
    [sessionId, workspacePath]
  );
  const latestDraft = useRef({ prompt, attachments, modified });
  latestDraft.current = { prompt, attachments, modified };
  useEffect(
    () => () => {
      const draft = latestDraft.current;
      if (draft.modified)
        void persistDraft(draft.prompt, draft.attachments).catch(() => {});
    },
    [persistDraft]
  );
  const send = async (text = prompt) => {
    if (busy || !text.trim() || !workspacePath) return;
    setBusy(true);
    setError(null);
    try {
      await persistDraft(text, attachments);
      await window.electronAPI.invoke(
        "ai:queueRemotePrompt",
        sessionId,
        workspacePath,
        text,
        attachments,
        turnOptions
      );
      setPrompt("");
      setAttachments([]);
      setModified(Date.now());
      await persistDraft("", []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The prompt could not be sent."
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setError(null);
    try {
      await window.electronAPI.invoke(
        "ai:cancelRemoteSession",
        sessionId,
        workspacePath
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The stop request could not be sent."
      );
    }
  };
  const launchAction = async (action: ActionPrompt) => {
    if (!workspacePath || busy) return;
    setBusy(true);
    setError(null);
    try {
      const host = snapshot?.session.metadata?.remoteHostDeviceId;
      const id = await window.electronAPI.invoke(
        "ai:createRemoteSession",
        workspacePath,
        host,
        {
          prompt: action.config?.autoSubmit === false ? undefined : action.body,
          model:
            action.config?.model ??
            turnOptions.model ??
            snapshot?.session.model,
          parentSessionId: snapshot?.session.parentSessionId,
          worktree: action.config?.worktree,
        }
      );
      if (action.config?.autoSubmit === false)
        await window.electronAPI.invoke(
          "ai:saveRemoteDraft",
          id,
          workspacePath,
          { text: action.body, attachments: [] }
        );
      if (action.config?.foreground !== false)
        window.dispatchEvent(
          new CustomEvent("open-ai-session", {
            detail: { sessionId: id, workspacePath },
          })
        );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The Action could not be launched."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="remote-session-transcript flex h-full min-h-0 flex-col text-[var(--nim-text)]"
      data-testid="remote-session-transcript"
    >
      <div
        className="remote-session-status flex items-center gap-3 border-b border-[var(--nim-border)] px-4 py-2 text-[12px] text-[var(--nim-text-muted)]"
        data-testid="remote-session-status"
      >
        {!snapshot
          ? "Connecting…"
          : snapshot.readOnlyReason
          ? "History only"
          : !snapshot.hostOnline
          ? "Host offline"
          : snapshot.syncing
          ? "Loading transcript…"
          : snapshot.executing
          ? "Working"
          : "Ready"}
        {!!snapshot?.queuedPrompts.length && (
          <span>{snapshot.queuedPrompts.length} queued</span>
        )}
      </div>
      {snapshot?.readOnlyReason && (
        <p
          role="status"
          className="px-4 py-2 text-[13px] text-[var(--nim-text-muted)]"
        >
          {snapshot.readOnlyReason}
        </p>
      )}
      {(error || connectionError || snapshot?.error) && (
        <p
          role="alert"
          className="px-4 py-2 text-[13px] text-[var(--nim-error)]"
        >
          {error || connectionError || snapshot?.error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        <RichTranscriptView
          sessionId={sessionId}
          messages={snapshot?.session.messages ?? []}
          provider={snapshot?.session.provider}
          isProcessing={snapshot?.executing}
          hideEmptyHelp
        />
      </div>
      {workspacePath && (
        <SessionAIInput
          ref={input}
          sessionId={sessionId}
          workspacePath={workspacePath}
          enableAttachments
          persistDraft={persistDraft}
          remoteSession
          enableSlashCommands
          remoteFiles={context?.files}
          remoteCommands={context?.commands}
          onAttachmentAdd={(attachment) => {
            edited.current = true;
            setAttachments((previous) => [...previous, attachment]);
            setModified(Date.now());
          }}
          onAttachmentRemove={(id) => {
            edited.current = true;
            setAttachments((previous) =>
              previous.filter((file) => file.id !== id)
            );
            setModified(Date.now());
          }}
          onSend={(text) => void send(text)}
          onQueue={(text) => void send(text)}
          onCancel={() => void cancel()}
          isLoading={snapshot?.executing}
          disabled={
            busy ||
            !hydrated ||
            !!snapshot?.readOnlyReason ||
            !snapshot?.hostOnline
          }
          sessionHasMessages
          currentProvider={snapshot?.session.provider ?? "claude-code"}
          currentModel={
            turnOptions.model ?? snapshot?.session.model ?? "claude-code:sonnet"
          }
          mode={turnOptions.mode}
          onModeChange={(mode) => updateOptions({ mode })}
          onModelChange={(model) => {
            if (!model.startsWith("claude-code:")) {
              setError("This machine currently runs Claude Code models.");
              return;
            }
            updateOptions({ model });
          }}
          showEffortLevel
          effortLevel={turnOptions.effortLevel}
          onEffortLevelChange={(effortLevel) => updateOptions({ effortLevel })}
          onLaunchActionInNewSession={launchAction}
          queueCount={snapshot?.queuedPrompts.length}
        />
      )}
    </div>
  );
});
RemoteSessionTranscript.displayName = "RemoteSessionTranscript";
