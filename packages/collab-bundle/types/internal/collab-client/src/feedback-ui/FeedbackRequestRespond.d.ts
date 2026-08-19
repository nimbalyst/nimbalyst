/**
 * FeedbackRequestRespond
 *
 * The recipient's view of a feedback request, embedded wherever the request is
 * delivered. Same card as the transcript compose widget, so a request looks
 * the same whether it is being drafted, answered, or tallied.
 *
 * Three things carry this surface:
 *
 * - **You see only what is assigned to you.** The ask list comes from the
 *   protocol's assignment model (`feedbackRespondAsks`), and the submit gate
 *   runs the server's own `validateFeedbackResponse`. Neither check lives in
 *   the JSX, and neither is a filter invented here.
 * - **The comment link is quiet and unconditioned.** It sits in the footer note
 *   slot rather than beside `Submit answers`, and -- this is the part that
 *   matters -- it is still there after submitting. A recipient who cannot
 *   answer, because the question is wrong or they need something cleared up,
 *   must never hit a dead end; that failure is worse than a slightly lower
 *   structured-response rate.
 * - **What the server withheld stays withheld.** Under `hiddenUntilAnswered`
 *   the server decides which responses this viewer may see. This component
 *   renders the response set it was handed and adds no filter of its own -- a
 *   client-side re-filter would mask a server bug rather than prevent one.
 *
 * Draft answers live in this component. No parent holds a copy.
 */
import React from 'react';
import type { FeedbackAnswer } from '@nimbalyst/collab-protocol';
import type { FeedbackRequestServiceState } from '../feedback/index';
import type { FeedbackOptionPreviewRenderer } from './FeedbackRespondOptionCards';
import { type FeedbackArtifactActionResolver, type FeedbackSubjectOpener } from './FeedbackArtifactSubjects';
export interface FeedbackRespondSubmitResult {
    success: boolean;
    error?: string;
}
/**
 * Optional, exactly as on the compose surface: with no host the surface still
 * renders the request honestly and says plainly that it cannot send.
 */
export interface FeedbackRespondHost {
    submitAnswers(answers: Array<{
        askId: string;
        answer: FeedbackAnswer;
    }>): Promise<FeedbackRespondSubmitResult>;
}
export interface FeedbackRequestRespondProps {
    state: FeedbackRequestServiceState;
    host?: FeedbackRespondHost;
    /** Host-owned discussion surface; the respond tree knows no comment system. */
    discussion?: React.ReactNode;
    /** Per-option artifact previews, when the embedding surface has them. */
    renderOptionPreview?: FeedbackOptionPreviewRenderer;
    /**
     * Opens a subject or a bound artifact. Host-supplied because the mechanics
     * differ per host -- a tab in the desktop app, a route in the browser -- and
     * neither belongs in this tree. Absent means the subjects still render, as
     * text.
     */
    onOpenSubject?: FeedbackSubjectOpener;
    /** Resolves each artifact before an open affordance is rendered. */
    resolveArtifactAction?: FeedbackArtifactActionResolver;
    /** Overridden in tests; deadline copy is the only thing that reads it. */
    now?: number;
}
export declare const FeedbackRequestRespond: React.FC<FeedbackRequestRespondProps>;
