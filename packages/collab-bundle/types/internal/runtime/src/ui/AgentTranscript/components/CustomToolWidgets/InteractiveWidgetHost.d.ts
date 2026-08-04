/**
 * InteractiveWidgetHost Interface
 *
 * Provides communication between interactive tool widgets and the host (SessionTranscript).
 * Similar to EditorHost pattern - widgets receive a host object and call methods on it,
 * keeping the complex logic (atoms, callbacks, analytics) in the host implementation.
 *
 * This interface lives in runtime so widgets can use it without Electron-specific dependencies.
 */
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
    gitCommit(proposalId: string, files: string[], message: string): Promise<{
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
     * Track an analytics event
     */
    trackEvent(eventName: string, properties?: Record<string, unknown>): void;
}
export declare const noopInteractiveWidgetHost: InteractiveWidgetHost;
