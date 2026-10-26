import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { VListHandle } from 'virtua';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import { partitionUnansweredQuestions } from '../../../ai/server/interactivePromptTools';
import { isToolLikeMessage } from '../utils/messageTypeHelpers';

export interface PendingQuestion {
  id: string;
  rowIndex: number;
}

// Permission, plan and commit prompts intentionally have separate navigation.
// A question the user moved past by sending a new message is closed, so only
// open questions drive the Jump button and auto-scroll.
export function findPendingQuestions(messages: TranscriptViewMessage[]): PendingQuestion[] {
  return partitionUnansweredQuestions(messages).open
    .filter(({ index }) => isToolLikeMessage(messages[index]))
    .map(({ id, index }) => {
      // Target the assistant row that encloses the contiguous tool group.
      let rowIndex = index;
      while (rowIndex < messages.length && isToolLikeMessage(messages[rowIndex])) rowIndex++;
      return { id, rowIndex: messages[rowIndex]?.type === 'assistant_message' ? rowIndex : index };
    });
}

/**
 * The question a live agent turn is waiting on. Several cards can be open: a
 * question abandoned without a result stays open after the agent re-asks it
 * under a new id. Open questions are in transcript order, so the newest is last.
 */
export function newestPendingQuestion(questions: readonly PendingQuestion[]): PendingQuestion | undefined {
  return questions[questions.length - 1];
}

/**
 * Auto-jump fires once per newly opened question, and only ever to the newest
 * one: an older open card never pulls the view.
 */
export function selectAutoJumpQuestion(
  questions: readonly PendingQuestion[],
  revealed: ReadonlySet<string>,
): PendingQuestion | undefined {
  const newest = newestPendingQuestion(questions);
  return newest && !revealed.has(newest.id) ? newest : undefined;
}

export function usePendingQuestionNavigation({ messages, sessionId, ready, vlistRef, scrollContainerRef }: {
  messages: TranscriptViewMessage[];
  sessionId: string;
  ready: boolean;
  vlistRef: RefObject<VListHandle | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const pendingQuestions = useMemo(() => findPendingQuestions(messages), [messages]);
  // Question ids already shown, per session. Kept across visibility changes and
  // in-place session switches so coming back to a pane does not replay a jump
  // the user already scrolled away from.
  const revealedRef = useRef(new Map<string, Set<string>>());
  const revealedFor = useCallback((id: string) => {
    let revealed = revealedRef.current.get(id);
    if (!revealed) revealedRef.current.set(id, revealed = new Set());
    return revealed;
  }, []);
  const frameRef = useRef<number | null>(null);
  const latestRef = useRef({ sessionId, pendingQuestions });
  latestRef.current = { sessionId, pendingQuestions };

  const cancelJump = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const jumpToQuestion = useCallback((question: PendingQuestion) => {
    cancelJump();
    if (!vlistRef.current) return;
    vlistRef.current.scrollToIndex(question.rowIndex, { align: 'start' });
    // VList must mount the row first. A row can contain many tools, so its top
    // alone is not enough: align the actual card within this scroll container.
    let attempts = 0;
    const revealCard = () => {
      frameRef.current = null;
      const latest = latestRef.current;
      const target = latest.pendingQuestions.find(candidate => candidate.id === question.id);
      if (latest.sessionId !== sessionId || !target || !vlistRef.current) return;
      // Shown once a reveal frame runs; a jump cancelled before this (pane hidden,
      // session switched) leaves the question to auto-jump again.
      revealedFor(sessionId).add(target.id);
      const container = scrollContainerRef.current;
      const card = Array.from(container?.querySelectorAll<HTMLElement>('[data-transcript-tool-id]') ?? [])
        .find(element => element.dataset.transcriptToolId === target.id);
      if (card && container) {
        vlistRef.current.scrollBy(card.getBoundingClientRect().top - container.getBoundingClientRect().top - 8);
      } else if (++attempts < 6) {
        vlistRef.current.scrollToIndex(target.rowIndex, { align: 'start' });
        frameRef.current = requestAnimationFrame(revealCard);
      }
    };
    frameRef.current = requestAnimationFrame(revealCard);
  }, [cancelJump, revealedFor, scrollContainerRef, sessionId, vlistRef]);

  useEffect(() => {
    if (!ready) {
      cancelJump();
      return;
    }
    const revealed = revealedFor(sessionId);
    const target = selectAutoJumpQuestion(pendingQuestions, revealed);
    // Older open cards never pull the view, not even after the newest one closes.
    pendingQuestions.forEach(question => { if (question !== target) revealed.add(question.id); });
    if (target) jumpToQuestion(target);
  }, [pendingQuestions, ready, sessionId, jumpToQuestion, cancelJump, revealedFor]);

  useEffect(() => cancelJump, [cancelJump, sessionId]);

  const jumpToNewestQuestion = useCallback(() => {
    const newest = newestPendingQuestion(latestRef.current.pendingQuestions);
    if (newest) jumpToQuestion(newest);
  }, [jumpToQuestion]);

  /** Whether the next ready pass will auto-jump, so the caller should not scroll to the bottom first. */
  const hasQuestionToReveal = useCallback(() => {
    const { sessionId: currentSessionId, pendingQuestions: current } = latestRef.current;
    return selectAutoJumpQuestion(current, revealedFor(currentSessionId)) !== undefined;
  }, [revealedFor]);

  return { pendingQuestions, jumpToNewestQuestion, hasQuestionToReveal };
}
