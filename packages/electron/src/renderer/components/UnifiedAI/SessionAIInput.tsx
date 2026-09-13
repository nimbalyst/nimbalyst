import React, { forwardRef, useCallback, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import type { ChatAttachment } from "@nimbalyst/runtime/ai/server/types";
import { AIInput, type AIInputRef } from "./AIInput";
import {
  sessionDraftInputAtom,
  sessionDraftHydratedAtom,
  sessionDraftAttachmentsAtom,
  sessionDraftLocalModifiedAtAtom,
  canPersistSessionDraft,
} from "../../store/atoms/sessions";

// Props for the input wrapper — same as AIInput minus the value/onChange
// pair (which the wrapper owns) and attachments handling (we wire it up
// directly so the attachments subscription is isolated too).
type SessionAIInputProps = Omit<
  React.ComponentProps<typeof AIInput>,
  | "value"
  | "onChange"
  | "attachments"
  | "onAttachmentAdd"
  | "onAttachmentRemove"
> & {
  sessionId: string;
  workspacePath: string;
  enableAttachments: boolean;
  persistDraft?: (text: string, attachments: ChatAttachment[]) => Promise<void>;
  onAttachmentAdd?: (attachment: ChatAttachment) => void;
  onAttachmentRemove?: (attachmentId: string) => void;
};

/**
 * Thin wrapper that owns the draft-input and draft-attachments
 * subscriptions for one session. Extracted from SessionTranscript so that
 * each keystroke re-renders only this component (and the textarea inside
 * AIInput) instead of cascading through the entire transcript / banners /
 * queue list — which used to break text selection in the messages area.
 *
 * Also owns the debounced persistence of the draft to PGLite (formerly in
 * SessionTranscript), since that effect needs to fire on every draftInput
 * change.
 */
export const SessionAIInput = forwardRef<AIInputRef, SessionAIInputProps>(
  function SessionAIInput(
    {
      sessionId,
      workspacePath,
      enableAttachments,
      onAttachmentAdd,
      onAttachmentRemove,
      persistDraft,
      ...rest
    },
    ref
  ) {
    const [draftInput, setDraftInputRaw] = useAtom(
      sessionDraftInputAtom(sessionId)
    );
    const draftHydrated = useAtomValue(sessionDraftHydratedAtom(sessionId));
    const draftAttachments = useAtomValue(
      sessionDraftAttachmentsAtom(sessionId)
    );
    const [draftLocalModifiedAt, setDraftLocalModifiedAt] = useAtom(
      sessionDraftLocalModifiedAtAtom(sessionId)
    );

    const handleChange = useCallback(
      (value: string) => {
        setDraftInputRaw(value);
        setDraftLocalModifiedAt(Date.now());
      },
      [setDraftInputRaw, setDraftLocalModifiedAt]
    );

    // Debounced persistence of draft input to database — survives restarts.
    useEffect(() => {
      if (!workspacePath) return;
      if (!canPersistSessionDraft(draftHydrated, draftLocalModifiedAt)) return;
      const timeoutId = setTimeout(() => {
        (persistDraft
          ? persistDraft(draftInput, draftAttachments)
          : window.electronAPI.invoke(
              "ai:saveDraftInput",
              sessionId,
              draftInput,
              workspacePath
            )
        ).catch((err) =>
          console.error("[SessionAIInput] Failed to persist draft input:", err)
        );
      }, 1000);
      return () => clearTimeout(timeoutId);
    }, [
      sessionId,
      draftInput,
      draftHydrated,
      draftLocalModifiedAt,
      workspacePath,
      draftAttachments,
      persistDraft,
    ]);

    return (
      <AIInput
        ref={ref}
        value={draftInput}
        onChange={handleChange}
        workspacePath={workspacePath}
        sessionId={sessionId}
        attachments={enableAttachments ? draftAttachments : undefined}
        onAttachmentAdd={enableAttachments ? onAttachmentAdd : undefined}
        onAttachmentRemove={enableAttachments ? onAttachmentRemove : undefined}
        {...rest}
      />
    );
  }
);
