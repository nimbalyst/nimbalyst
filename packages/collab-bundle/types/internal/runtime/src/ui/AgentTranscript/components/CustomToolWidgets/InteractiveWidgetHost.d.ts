/**
 * InteractiveWidgetHost Interface
 *
 * Provides communication between interactive tool widgets and the host (SessionTranscript).
 * Similar to EditorHost pattern - widgets receive a host object and call methods on it,
 * keeping the complex logic (atoms, callbacks, analytics) in the host implementation.
 *
 * This interface lives in runtime so widgets can use it without Electron-specific dependencies.
 */
import type React from 'react';
import type { FeedbackAskArtifact } from '@nimbalyst/collab-protocol';
import type { HunkSelection } from '../../../git/unifiedDiffModel';
export type { HunkSelection };
export interface AskUserQuestionResponse {
    answers: Record<string, string>;
    cancelled?: boolean;
}
import type { RequestUserInputAnswer } from '../../../../ai/server/providers/shared/requestUserInputTypes';
export type { RequestUserInputAnswer };
export interface RequestUserInputResponse {
    answers: Record<string, RequestUserInputAnswer>;
    cancelled?: boolean;
}
import type { FeedbackComposeDestination, FeedbackComposeSendPayload } from './feedback/feedbackComposeDraft';
export type { FeedbackComposeDestination, FeedbackComposeSendPayload };
/**
 * Declared with protocol types rather than imported from `collab-client`,
 * which depends on this package and cannot be depended on back. Structurally
 * identical to that package's `FeedbackOptionPreviewRenderer`, so one host
 * implementation satisfies both surfaces.
 */
export type FeedbackComposeArtifactRenderer = (entry: {
    id: string;
    label: string;
}, artifact: FeedbackAskArtifact) => React.ReactNode;
/** One entry the compose popover can step to. */
export interface FeedbackComposeArtifactEntry {
    entryId: string;
    artifact: FeedbackAskArtifact;
    label: string;
}
export interface FeedbackComposeArtifactPopoverProps {
    entries: readonly FeedbackComposeArtifactEntry[];
    activeEntryId: string;
    onActiveEntryChange(entryId: string): void;
    onDismiss(): void;
    /** The card the popover grew from, so it anchors where the click landed. */
    anchor: HTMLElement | null;
}
/**
 * Opens one artifact full-size, in place.
 *
 * Same reason the renderer above is injected: the popover lives in
 * `collab-client`, which depends on this package, so this package cannot
 * import it. The Electron host can, and does.
 */
export type FeedbackComposeArtifactPopoverRenderer = (props: FeedbackComposeArtifactPopoverProps) => React.ReactNode;
export interface FeedbackRequestSendResult {
    success: boolean;
    /** Server-assigned request id, once the request exists. */
    requestId?: string;
    /**
     * The pasteable web link for the request, built by the host from its
     * configured console origin. Present on success; the widget offers it as the
     * confirmation's copy action, because a recipient without the desktop app is
     * notified through no other channel.
     */
    shareUrl?: string;
    /** A non-blocking integration limitation to show with the sent confirmation. */
    warning?: string;
    error?: string;
}
export interface ExitPlanModeResponse {
    approved: boolean;
    feedback?: string;
    startNewSession?: boolean;
}
export type PermissionScope = 'once' | 'session' | 'always' | 'always-all';
export interface ToolPermissionResponse {
    decision: 'allow' | 'deny';
    scope: PermissionScope;
}
export interface GitCommitResponse {
    action: 'committed' | 'cancelled';
    commitHash?: string;
    error?: string;
}
export interface InteractiveWidgetHost {
    /**
     * Session and workspace context
     */
    sessionId: string;
    workspacePath: string;
    worktreeId?: string | null;
    /**
     * Submit answers to an AskUserQuestion tool call
     */
    askUserQuestionSubmit(questionId: string, answers: Record<string, string>): Promise<void>;
    /**
     * Cancel an AskUserQuestion tool call
     */
    askUserQuestionCancel(questionId: string): Promise<void>;
    /**
     * Submit answers to a RequestUserInput tool call. Answers is keyed by field.id.
     */
    requestUserInputSubmit(promptId: string, answers: Record<string, RequestUserInputAnswer>): Promise<void>;
    /**
     * Cancel a RequestUserInput tool call.
     */
    requestUserInputCancel(promptId: string): Promise<void>;
    /**
     * Publish any confirmed subjects and create the feedback request.
     *
     * Optional: the compose surface renders and validates a draft without it, and
     * disables sending until a host that can reach the collaboration layer is
     * installed (plan slice S3). Keeping it optional is also what stops the local
     * AskUserQuestion path acquiring a transport dependency by proximity.
     */
    feedbackRequestSend?(payload: FeedbackComposeSendPayload): Promise<FeedbackRequestSendResult>;
    /**
     * Ask the author which team-files folder this request's subjects land in.
     *
     * Resolves null when the picker is dismissed, which leaves the draft's
     * destination exactly as it was -- dismissing a picker is not a choice.
     *
     * Optional like the rest of this section. Without it the compose surface
     * still names the destination it will use; it just has no way to change it,
     * and publishing falls back to asking per subject at send time. The folder
     * index lives in the Electron renderer and has no mobile counterpart, which
     * is why this is a host method and not a tree rendered in this package.
     */
    pickFeedbackDestination?(current: {
        folderId: string | null;
        /** How many subjects are being placed, so the picker can say so. */
        subjectCount: number;
    }): Promise<FeedbackComposeDestination | null>;
    /**
     * Paint one artifact bound to an ask entry, so the author can see what they
     * are about to send rather than a label for it.
     *
     * Optional for the same reason `feedbackRequestSend` is: the compose surface
     * renders a complete, honest draft without it, and a host that cannot reach
     * the custom-editor registry simply shows the titled placeholder. It also
     * keeps this package free of a dependency on the editor registry, which lives
     * in the Electron renderer and has no mobile counterpart.
     *
     * Returning nullish is a supported answer -- "I can paint artifacts, and this
     * one has nothing to show" -- and lands on the same placeholder.
     */
    renderFeedbackArtifactPreview?: FeedbackComposeArtifactRenderer;
    /**
     * Opens a bound artifact full-size from the compose surface.
     *
     * A 128px card scaled from a 1000px design is a *recognition* aid and
     * nothing more -- a dark mockup at that size is a dark smudge. Reviewing a
     * draft means being able to look at what you are about to send, so the card
     * needs a way in. Optional, like everything else here: without it the card
     * still shows its preview and simply cannot be opened.
     */
    renderFeedbackArtifactPopover?: FeedbackComposeArtifactPopoverRenderer;
    /** Discard a drafted feedback request without sending it. */
    feedbackRequestCancel?(draftId: string): Promise<void>;
    /**
     * Approve exiting plan mode and switch to agent mode
     */
    exitPlanModeApprove(requestId: string): Promise<void>;
    /**
     * Approve and start a new implementation session
     * Handles workstream creation, worktree sessions, etc.
     */
    exitPlanModeStartNewSession(requestId: string, planFilePath: string): Promise<void>;
    /**
     * Deny exit and continue planning, optionally with feedback
     */
    exitPlanModeDeny(requestId: string, feedback?: string): Promise<void>;
    /**
     * Cancel the request and stop the session
     */
    exitPlanModeCancel(requestId: string): Promise<void>;
    /**
     * Submit a tool permission response (allow/deny with scope)
     */
    toolPermissionSubmit(requestId: string, response: ToolPermissionResponse): Promise<void>;
    /**
     * Cancel a tool permission request
     */
    toolPermissionCancel(requestId: string): Promise<void>;
    /**
     * Execute a git commit with the given files and message.
     * Returns the commit result. On mobile, returns { pending: true } to indicate
     * the commit was sent to desktop but hasn't completed yet.
     */
    gitCommit(proposalId: string, files: string[], message: string, 
    /**
     * Desktop-only. Files listed here are staged down to the named hunks
     * instead of whole. Mobile has no local working tree, so it never sends
     * this and every file goes in whole.
     */
    hunkSelections?: HunkSelection[]): Promise<{
        success: boolean;
        commitHash?: string;
        commitDate?: string;
        error?: string;
        pending?: boolean;
    }>;
    /**
     * Cancel a git commit proposal
     */
    gitCommitCancel(proposalId: string): Promise<void>;
    /**
     * Fetch the unified diff for a single file in the working tree (HEAD vs working tree).
     * Used by interactive widgets (e.g. the git commit proposal) to peek at a file's
     * pending changes. Returns null if the platform does not support inline diffs
     * (e.g. mobile, where the working tree is not local).
     */
    gitFileDiff?(filePath: string): Promise<{
        unifiedDiff: string;
        isBinary: boolean;
    } | null>;
    /**
     * Unified diff of what *this session* changed in a file, from its own
     * pre-edit snapshot to its post-edit content. Distinct from `gitFileDiff`,
     * which is HEAD vs the working tree and therefore includes sibling sessions'
     * edits. Returns null when the session has no snapshot baseline for the file.
     */
    sessionFileDiff?(filePath: string): Promise<{
        unifiedDiff: string;
    } | null>;
    /**
     * Persisted size of the diff peek popover, or null to use the default.
     * Shared with the git extension's changes panel.
     */
    diffPeekSize?: {
        width: number;
        height: number;
    } | null;
    /**
     * Persist a new size for the diff peek popover (debounced by the host).
     */
    setDiffPeekSize?(size: {
        width: number;
        height: number;
    }): void;
    /**
     * Whether auto-commit is enabled for git commit proposals.
     * When true, GitCommitConfirmationWidget auto-triggers commit without user input.
     */
    autoCommitEnabled: boolean;
    /**
     * Set whether auto-commit is enabled.
     * Used by the widget to let users disable auto-commit after a successful commit.
     */
    setAutoCommitEnabled(enabled: boolean): void;
    /**
     * Submit user feedback for a blocked Super Loop iteration.
     * Sends the feedback to the same session, waits for Claude to process it,
     * then continues the Super Loop.
     */
    superLoopBlockedFeedback(feedback: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /** Query whether the workspace can offer an opt-in gitignore entry. */
    getAttachmentStagingGitignoreStatus?(): Promise<{
        isGitRepo: boolean;
        alreadyIgnored: boolean;
        shouldOffer: boolean;
    }>;
    /** Switch to workspace staging, re-stage the attachments, and resend the prompt. */
    retryAttachmentStaging?(prompt: string, attachments: Array<{
        id: string;
        filename: string;
        filepath: string;
        mimeType: string;
        size: number;
        type: string;
        addedAt?: number;
    }>, addGitignore: boolean): Promise<{
        success: boolean;
        error?: string;
    }>;
    /** Open the application attachment staging settings. */
    openAttachmentSettings?(): void;
    /**
     * Open a file in the editor
     */
    openFile(filePath: string): Promise<void>;
    /**
     * Open a page an agent edited: a shared page (`collab://`), a typed page
     * (`tracker://<itemId>` or `collab://tracker-content/<itemId>`) or a Personal
     * page (`personal://...`). Optional: a host without a page tree (mobile) leaves
     * the "Updated <page>" line as plain text.
     */
    openPage?(uri: string): Promise<void>;
    /**
     * Track an analytics event
     */
    trackEvent(eventName: string, properties?: Record<string, unknown>): void;
}
export declare const noopInteractiveWidgetHost: InteractiveWidgetHost;
