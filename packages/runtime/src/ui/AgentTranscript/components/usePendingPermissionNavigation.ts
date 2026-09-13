import { useMemo, useEffect, useRef, useState, type RefObject } from 'react';
import type { VListHandle } from 'virtua';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import { isToolLikeMessage } from '../utils/messageTypeHelpers';

/** Existing permission navigation, separate from question-only navigation. */
export function usePendingPermissionNavigation({ messages, sessionId, sessionStatus, isProcessing, currentTeammates, vlistRef }: {
  messages: TranscriptViewMessage[];
  sessionId: string;
  sessionStatus?: string;
  isProcessing?: boolean;
  currentTeammates?: Array<{ status: string }>;
  vlistRef: RefObject<VListHandle | null>;
}) {
  const pendingPermissionsVisibleRef = useRef(true);
  const [showPermissionBanner, setShowPermissionBanner] = useState(false);
  // Find pending (unresolved) ToolPermission widgets and the VList indices where they're actually rendered.
  // Tool messages are hidden (display:none) and rendered inside the next assistant message via toolMessagesBefore,
  // so we need to find the assistant message index for scroll targeting.
  const pendingPermissionIndices = useMemo(() => {
    // Don't show banner for stopped/completed sessions.
    // Session is active if processing, running/waiting status, or teammates are still running.
    const hasActiveTeammates = currentTeammates?.some(t => t.status === 'running' || t.status === 'idle') ?? false;
    const sessionActive = isProcessing || sessionStatus === 'running' || sessionStatus === 'waiting' || hasActiveTeammates;
    if (!sessionActive) return [];
    const indices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (isToolLikeMessage(msg) && msg.toolCall?.toolName === 'ToolPermission' && !msg.toolCall.result) {
        // Find the next assistant message that renders this tool via toolMessagesBefore
        let targetIdx = i + 1;
        while (targetIdx < messages.length && isToolLikeMessage(messages[targetIdx])) {
          targetIdx++;
        }
        if (targetIdx < messages.length && messages[targetIdx].type === 'assistant_message') {
          indices.push(targetIdx); // Scroll to the assistant message that contains this widget
        } else {
          indices.push(i); // Orphaned tool - rendered at its own index
        }
      }
    }
    return indices;
  }, [messages, isProcessing, sessionStatus, currentTeammates]);

  // Update banner visibility when pending permissions are resolved or new ones appear
  useEffect(() => {
    if (pendingPermissionIndices.length === 0) {
      setShowPermissionBanner(false);
      pendingPermissionsVisibleRef.current = true;
    } else {
      // Always show banner initially when pending permissions exist.
      // The onScroll handler will hide it if the permissions are actually visible.
      // This fixes the case where auto-scroll pushes past the permission widget
      // while isAtBottom is true (making us incorrectly assume visibility).
      setShowPermissionBanner(true);
      pendingPermissionsVisibleRef.current = false;

      // Schedule a visibility check after auto-scroll completes (auto-scroll uses double RAF).
      // Triple RAF ensures we run after auto-scroll's double RAF + the resulting scroll event.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (pendingPermissionIndices.length === 0) return;
            if (!vlistRef.current) return;
            const offset = vlistRef.current.scrollOffset;
            const viewportSize = vlistRef.current.viewportSize;
            const firstVisibleIdx = vlistRef.current.findItemIndex(offset);
            const lastVisibleIdx = vlistRef.current.findItemIndex(offset + viewportSize);
            const anyVisible = pendingPermissionIndices.some(
              idx => idx >= firstVisibleIdx && idx <= lastVisibleIdx
            );
            pendingPermissionsVisibleRef.current = anyVisible;
            setShowPermissionBanner(!anyVisible);
          });
        });
      });
    }
  }, [pendingPermissionIndices, sessionId]);

  return { pendingPermissionIndices, pendingPermissionsVisibleRef, showPermissionBanner, setShowPermissionBanner };
}
