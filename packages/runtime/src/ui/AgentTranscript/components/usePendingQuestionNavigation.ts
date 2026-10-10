import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import type { VListHandle } from 'virtua';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import { partitionUnansweredQuestions } from '../../../ai/server/interactivePromptTools';
import { isToolLikeMessage } from '../utils/messageTypeHelpers';

interface PendingQuestion {
  id: string;
  rowIndex: number;
}

// Permission, plan and commit prompts intentionally have separate navigation.
// A question the user moved past by sending a new message is closed, so only
// open questions drive the Jump button and auto-scroll.
function findPendingQuestions(messages: TranscriptViewMessage[]): PendingQuestion[] {
  return partitionUnansweredQuestions(messages).open
    .filter(({ index }) => isToolLikeMessage(messages[index]))
    .map(({ id, index }) => {
      // Target the assistant row that encloses the contiguous tool group.
      let rowIndex = index;
      while (rowIndex < messages.length && isToolLikeMessage(messages[rowIndex])) rowIndex++;
      return { id, rowIndex: messages[rowIndex]?.type === 'assistant_message' ? rowIndex : index };
    });
}

export function usePendingQuestionNavigation({ messages, sessionId, ready, vlistRef, scrollContainerRef }: {
  messages: TranscriptViewMessage[];
  sessionId: string;
  ready: boolean;
  vlistRef: RefObject<VListHandle | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const pendingQuestions = useMemo(() => findPendingQuestions(messages), [messages]);
  const navigationRef = useRef<{ sessionId: string; seen: Set<string> }>({ sessionId, seen: new Set() });
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
  }, [cancelJump, scrollContainerRef, sessionId, vlistRef]);

  useEffect(() => {
    if (navigationRef.current.sessionId !== sessionId) {
      navigationRef.current = { sessionId, seen: new Set() };
    }
    if (!ready) {
      cancelJump();
      navigationRef.current.seen.clear();
      return;
    }
    const unseen = pendingQuestions.filter(question => !navigationRef.current.seen.has(question.id));
    if (unseen.length === 0) return;
    unseen.forEach(question => navigationRef.current.seen.add(question.id));
    jumpToQuestion(unseen[0]);
  }, [pendingQuestions, ready, sessionId, jumpToQuestion, cancelJump]);

  useEffect(() => () => {
    cancelJump();
    navigationRef.current.seen.clear();
  }, [cancelJump, sessionId]);

  return { pendingQuestions, jumpToQuestion };
}
