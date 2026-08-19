/**
 * Pure draft logic for the feedback-request compose surface.
 *
 * Two things live here rather than in the widget, because they are the real
 * behaviour of this slice and a reader cannot see either one on screen:
 *
 * 1. **Tier is derived, never stored.** Tier 1 (quick ask) and Tier 2 (full
 *    request) are the same draft rendered at two disclosure levels. Promotion
 *    is a pure function of content -- a second recipient, a deadline, or a
 *    subject that is not team-visible -- so there is no mode flag to get out of
 *    sync, and demoting cannot discard what the author already entered: the
 *    fields simply stop being shown while their values stay in the draft.
 * 2. **Publishing an unshared subject is gated on an explicit confirmation
 *    that names the exact subjects.** The confirmation records the subject ids
 *    it covered, so adding another unshared subject afterwards re-blocks
 *    sending instead of silently riding along on a stale confirmation.
 *
 * Types come from `@nimbalyst/collab-protocol`; this module adds only the
 * compose-time view model (a subject's display label and shared flag are
 * presentation, not wire format) and carries no transport of its own.
 */
import type { FeedbackArtifact, FeedbackAsk, FeedbackAskAssignment, FeedbackRequestRecipient, FeedbackRequestVisibility, FeedbackRequestWakePolicy, ResourceRef } from '@nimbalyst/collab-protocol';
/**
 * A subject as the author sees it while composing: the wire `ResourceRef` plus
 * the label, context line, and team-visibility flag needed to render the
 * shared/not-shared dot and the publish prompt.
 */
export interface FeedbackComposeSubject {
    ref: ResourceRef;
    /** File name or title shown on the artifact chip. */
    label: string;
    /** Muted second line, e.g. the containing folder. */
    context?: string;
    /** True when the subject is already visible to the recipients' team. */
    shared: boolean;
}
/** Who counts as "enough answers to wake the session". */
export type FeedbackComposeQuorumMode = 'first' | 'all';
export interface FeedbackComposeDraft {
    /** Stable id for this draft; also the draft-atom key. */
    draftId: string;
    /** The org the request will be created in. */
    orgId: string;
    subjects: FeedbackComposeSubject[];
    asks: FeedbackAsk[];
    recipients: FeedbackRequestRecipient[];
    assignments: FeedbackAskAssignment[];
    visibility: FeedbackRequestVisibility;
    quorumMode: FeedbackComposeQuorumMode;
    /** Epoch ms, or undefined for no deadline. */
    deadline?: number;
    /**
     * Subject `sourceId`s the author explicitly agreed to publish. Cleared
     * whenever the unshared set changes, so a confirmation can never cover a
     * subject the author was not shown.
     */
    publishConfirmedSourceIds: string[];
    /**
     * Tier 1 shows delivery settings as one collapsed line; this reveals them in
     * place. It is presentation only -- expanding does NOT promote the tier, and
     * the tier does not depend on it.
     */
    settingsExpanded: boolean;
}
/** The protocol currently defines exactly one wake rule. */
export declare const FEEDBACK_COMPOSE_WAKE_POLICY: FeedbackRequestWakePolicy;
export declare function createEmptyFeedbackComposeDraft(draftId: string, orgId?: string): FeedbackComposeDraft;
export type FeedbackComposeTier = 'quick' | 'full';
export type FeedbackComposeTierPromotionReason = 'multipleRecipients' | 'deadline' | 'unsharedSubject';
/**
 * Every reason the draft is currently at Tier 2, in the order the plan lists
 * them. Empty means Tier 1.
 */
export declare function feedbackComposeTierPromotionReasons(draft: FeedbackComposeDraft): FeedbackComposeTierPromotionReason[];
export declare function feedbackComposeTier(draft: FeedbackComposeDraft): FeedbackComposeTier;
export declare function isAskAssignedTo(draft: FeedbackComposeDraft, askId: string, userId: string): boolean;
export declare function asksAssignedTo(draft: FeedbackComposeDraft, userId: string): FeedbackAsk[];
export declare function recipientsAssignedToAsk(draft: FeedbackComposeDraft, askId: string): FeedbackRequestRecipient[];
export declare function addRecipient(draft: FeedbackComposeDraft, recipient: FeedbackRequestRecipient): FeedbackComposeDraft;
/**
 * Drops the person and their assignments. Asks they were the only recipient of
 * are kept -- an ask is authored content, and orphaning it is visible in the
 * surface (it blocks send) rather than silently deleting the author's work.
 */
export declare function removeRecipient(draft: FeedbackComposeDraft, userId: string): FeedbackComposeDraft;
export declare function toggleAssignment(draft: FeedbackComposeDraft, askId: string, userId: string): FeedbackComposeDraft;
export declare function setDeadline(draft: FeedbackComposeDraft, deadline: number | undefined): FeedbackComposeDraft;
export declare function setVisibility(draft: FeedbackComposeDraft, visibility: FeedbackRequestVisibility): FeedbackComposeDraft;
export declare function setQuorumMode(draft: FeedbackComposeDraft, quorumMode: FeedbackComposeQuorumMode): FeedbackComposeDraft;
export declare function setSettingsExpanded(draft: FeedbackComposeDraft, settingsExpanded: boolean): FeedbackComposeDraft;
export declare function removeSubject(draft: FeedbackComposeDraft, sourceId: string): FeedbackComposeDraft;
/**
 * Records the author's explicit agreement to publish the subjects they were
 * shown. Nothing else in this module sets `publishConfirmedSourceIds`.
 */
export declare function confirmPublish(draft: FeedbackComposeDraft): FeedbackComposeDraft;
export declare function unsharedSubjects(draft: FeedbackComposeDraft): FeedbackComposeSubject[];
export type FeedbackComposeBlockedReason = 'noRecipients' | 'noAsks' | 'unassignedAsk' | 'unassignedRecipient';
export type FeedbackComposeSubmitPlan = {
    kind: 'blocked';
    reason: FeedbackComposeBlockedReason;
} | {
    kind: 'needsPublishConfirmation';
    subjects: FeedbackComposeSubject[];
} | {
    kind: 'ready';
    publishSubjectRefs: ResourceRef[];
};
/**
 * What pressing the primary button may do right now. The widget calls the host
 * only for `ready`; every other result is a reason not to send yet.
 */
export declare function feedbackComposeSubmitPlan(draft: FeedbackComposeDraft): FeedbackComposeSubmitPlan;
export declare const FEEDBACK_COMPOSE_BLOCKED_MESSAGES: Record<FeedbackComposeBlockedReason, string>;
export interface FeedbackComposeSendPayload {
    draftId: string;
    orgId: string;
    /**
     * Carries the author's label, not just the ref. Publishing rewrites a `file`
     * ref to the created `document`, so a recipient handed only refs would have
     * nothing to render but an opaque document id.
     */
    subjects: FeedbackArtifact[];
    asks: FeedbackAsk[];
    recipients: FeedbackRequestRecipient[];
    assignments: FeedbackAskAssignment[];
    visibility: FeedbackRequestVisibility;
    wakePolicy: FeedbackRequestWakePolicy;
    quorum: {
        requiredRecipientCount: number;
    };
    deadline?: number;
    /** Subjects the author confirmed publishing; empty when nothing needs it. */
    publishSubjectRefs: ResourceRef[];
}
export declare function requiredRecipientCount(draft: FeedbackComposeDraft): number;
export declare function feedbackComposeSendPayload(draft: FeedbackComposeDraft, publishSubjectRefs: ResourceRef[]): FeedbackComposeSendPayload;
export declare function describeVisibility(visibility: FeedbackRequestVisibility): string;
export declare function describeWake(draft: FeedbackComposeDraft): string;
/**
 * The single collapsed line Tier 1 shows instead of delivery fields. It reports
 * the draft's actual values rather than a fixed sentence, so a setting the
 * author changed before demoting back to Tier 1 is still stated honestly.
 */
export declare function describeComposeDefaults(draft: FeedbackComposeDraft, formatDeadline: (deadline: number) => string): string;
