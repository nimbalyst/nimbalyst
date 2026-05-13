/**
 * Interactive Prompt Test Helpers
 *
 * Test utilities for E2E testing interactive prompt widgets (AskUserQuestion,
 * ExitPlanMode, ToolPermission, GitCommitProposal) WITHOUT invoking the actual
 * AI agent.
 *
 * These helpers allow tests to:
 * 1. Create test sessions with mock messages directly in the database
 * 2. Insert pending interactive prompts that widgets will render
 * 3. Verify widgets appear and interact with them
 * 4. Insert result messages to test completed states
 *
 * Usage:
 * ```typescript
 * import {
 *   createTestSession,
 *   insertPendingAskUserQuestion,
 *   waitForAskUserQuestion,
 *   selectAskUserQuestionOption,
 *   submitAskUserQuestion,
 *   cleanupTestSessions
 * } from '../utils/interactivePromptTestHelpers';
 *
 * test('renders pending question', async () => {
 *   const sessionId = await createTestSession(page, workspacePath);
 *   await insertPendingAskUserQuestion(page, sessionId, questions);
 *   await waitForAskUserQuestion(page);
 *   // ... verify widget state
 * });
 * ```
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

// ============================================================
// Types
// ============================================================

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface InsertResult {
  id: string;
  messageId: string;
}

// ============================================================
// CSS Selectors for Widget Elements
// ============================================================

export const INTERACTIVE_PROMPT_SELECTORS = {
  // AskUserQuestion widget
  askUserQuestionWidget: '[data-testid="ask-user-question-widget"]',
  askUserQuestionPendingState: '[data-testid="ask-user-question-pending"]',
  askUserQuestionCompletedState: '[data-testid="ask-user-question-completed"]',
  askUserQuestionCancelledState: '[data-testid="ask-user-question-cancelled"]',
  askUserQuestionOption: '[data-testid="ask-user-question-option"]',
  askUserQuestionSubmitButton: '[data-testid="ask-user-question-submit"]',
  askUserQuestionCancelButton: '[data-testid="ask-user-question-cancel"]',

  // ExitPlanMode widget
  exitPlanModeWidget: '[data-testid="exit-plan-mode-widget"]',
  exitPlanModePendingState: '[data-testid="exit-plan-mode-pending"]',
  exitPlanModeApprovedState: '[data-testid="exit-plan-mode-approved"]',
  exitPlanModeDeniedState: '[data-testid="exit-plan-mode-denied"]',
  exitPlanModeApproveButton: '[data-testid="exit-plan-mode-approve"]',
  exitPlanModeStartNewSessionButton: '[data-testid="exit-plan-mode-new-session"]',
  exitPlanModeDenyButton: '[data-testid="exit-plan-mode-deny"]',
  exitPlanModeCancelButton: '[data-testid="exit-plan-mode-cancel"]',
  exitPlanModeFeedbackInput: '[data-testid="exit-plan-mode-feedback-input"]',
  exitPlanModeSendFeedbackButton: '[data-testid="exit-plan-mode-send-feedback"]',

  // ToolPermission widget
  toolPermissionWidget: '[data-testid="tool-permission-widget"]',
  toolPermissionPendingState: '[data-testid="tool-permission-pending"]',
  toolPermissionGrantedState: '[data-testid="tool-permission-granted"]',
  toolPermissionDeniedState: '[data-testid="tool-permission-denied"]',
  toolPermissionDenyButton: '[data-testid="tool-permission-deny"]',
  toolPermissionAllowOnceButton: '[data-testid="tool-permission-allow-once"]',
  toolPermissionAllowSessionButton: '[data-testid="tool-permission-allow-session"]',
  toolPermissionAllowAlwaysButton: '[data-testid="tool-permission-allow-always"]',

  // RequestUserInput widget
  requestUserInputWidget: '[data-testid="request-user-input-widget"]',
  requestUserInputPendingState: '[data-testid="request-user-input-pending"]',
  requestUserInputCompletedState: '[data-testid="request-user-input-completed"]',
  requestUserInputCancelledState: '[data-testid="request-user-input-cancelled"]',
  requestUserInputSubmitButton: '[data-testid="request-user-input-submit"]',
  requestUserInputCancelButton: '[data-testid="request-user-input-cancel"]',
  requestUserInputMultiSelectRow: '[data-testid="request-user-input-multiselect-row"]',
  requestUserInputSingleSelectRow: '[data-testid="request-user-input-singleselect-row"]',
  requestUserInputReorderRow: '[data-testid="request-user-input-reorder-row"]',
  requestUserInputReorderRemove: '[data-testid="request-user-input-reorder-remove"]',
  requestUserInputEditTextContent: '[data-testid="request-user-input-edittext-content"]',

  // GitCommitProposal widget
  gitCommitWidget: '[data-testid="git-commit-widget"]',
  gitCommitPendingState: '[data-testid="git-commit-pending"]',
  gitCommitCommittedState: '[data-testid="git-commit-committed"]',
  gitCommitCancelledState: '[data-testid="git-commit-cancelled"]',
  gitCommitFileCheckbox: '[data-testid="git-commit-file-checkbox"]',
  gitCommitMessageInput: '[data-testid="git-commit-message-input"]',
  gitCommitConfirmButton: '[data-testid="git-commit-confirm"]',
  gitCommitCancelButton: '[data-testid="git-commit-cancel"]',
};

// ============================================================
// Message Format Factories
// These generate properly formatted JSON strings for database insertion
// ============================================================

/**
 * Generate a nimbalyst_tool_use message for AskUserQuestion
 */
export function createAskUserQuestionMessage(
  questionId: string,
  questions: Question[]
): string {
  return JSON.stringify({
    type: 'nimbalyst_tool_use',
    id: questionId,
    name: 'AskUserQuestion',
    input: { questions }
  });
}

/**
 * Generate a nimbalyst_tool_result message for AskUserQuestion
 */
export function createAskUserQuestionResultMessage(
  questionId: string,
  answers: Record<string, string>,
  cancelled = false
): string {
  return JSON.stringify({
    type: 'nimbalyst_tool_result',
    tool_use_id: questionId,
    result: JSON.stringify({ answers, cancelled })
  });
}

/**
 * Generate a tool_use message for ExitPlanMode (SDK format)
 */
export function createExitPlanModeMessage(
  toolId: string,
  planFilePath?: string,
  allowedPrompts?: Array<{ tool: string; prompt: string }>
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: toolId,
        name: 'ExitPlanMode',
        input: { planFilePath, allowedPrompts }
      }]
    }
  });
}

/**
 * Generate a tool_result message for ExitPlanMode
 */
export function createExitPlanModeResultMessage(
  toolId: string,
  approved: boolean,
  feedback?: string
): string {
  const resultText = approved
    ? 'Approved: exited planning mode'
    : `Denied: continue planning. ${feedback || ''}`;

  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: resultText }]
      }]
    }
  });
}

/**
 * Generate a nimbalyst_tool_use message for ToolPermission
 */
export function createToolPermissionMessage(
  requestId: string,
  toolName: string,
  rawCommand: string,
  pattern: string,
  options?: {
    patternDisplayName?: string;
    isDestructive?: boolean;
    warnings?: string[];
    workspacePath?: string;
  }
): string {
  return JSON.stringify({
    type: 'nimbalyst_tool_use',
    id: requestId,
    name: 'ToolPermission',
    input: {
      requestId,
      toolName,
      rawCommand,
      pattern,
      patternDisplayName: options?.patternDisplayName || pattern,
      isDestructive: options?.isDestructive || false,
      warnings: options?.warnings || [],
      workspacePath: options?.workspacePath || ''
    }
  });
}

/**
 * Generate a nimbalyst_tool_result message for ToolPermission
 */
export function createToolPermissionResultMessage(
  requestId: string,
  decision: 'allow' | 'deny',
  scope: 'once' | 'session' | 'always' | 'always-all'
): string {
  return JSON.stringify({
    type: 'nimbalyst_tool_result',
    tool_use_id: requestId,
    result: JSON.stringify({ decision, scope })
  });
}

/**
 * Generate a tool_use message for GitCommitProposal (MCP format)
 */
export function createGitCommitProposalMessage(
  toolId: string,
  files: Array<string | { path: string; status: 'added' | 'modified' | 'deleted' }>,
  commitMessage: string,
  reasoning?: string
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: toolId,
        name: 'mcp__nimbalyst-mcp__developer_git_commit_proposal',
        input: {
          filesToStage: files,
          commitMessage,
          reasoning: reasoning || 'Test commit proposal'
        }
      }]
    }
  });
}

/**
 * Generate a tool_result message for GitCommitProposal
 */
export function createGitCommitProposalResultMessage(
  toolId: string,
  action: 'committed' | 'cancelled',
  commitHash?: string,
  error?: string
): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: JSON.stringify({ action, commitHash, error }) }]
      }]
    }
  });
}

// ============================================================
// Session & Message Helpers
// ============================================================

/**
 * Generate a UUID for test IDs
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Create a test session directly in the database
 */
export async function createTestSession(
  page: Page,
  workspacePath: string,
  options?: { title?: string; provider?: string; model?: string }
): Promise<string> {
  const sessionId = generateUUID();
  const result = await page.evaluate(
    async ({ sessionId, workspacePath, title, provider, model }) => {
      return await (window as any).electronAPI.invoke('test:insert-session', {
        id: sessionId,
        workspaceId: workspacePath,
        title: title || `Test Session ${Date.now()}`,
        provider: provider || 'claude-code',
        model: model || 'opus'
      });
    },
    { sessionId, workspacePath, title: options?.title, provider: options?.provider, model: options?.model }
  );

  if (!result.success) {
    throw new Error(`Failed to create test session: ${result.error}`);
  }

  return sessionId;
}

/**
 * Insert a raw message into the database
 */
export async function insertMessage(
  page: Page,
  sessionId: string,
  direction: 'input' | 'output',
  content: string,
  options?: { source?: string; metadata?: any }
): Promise<string> {
  const result = await page.evaluate(
    async ({ sessionId, direction, content, source, metadata }) => {
      return await (window as any).electronAPI.invoke('test:insert-message', {
        sessionId,
        direction,
        content,
        source,
        metadata
      });
    },
    { sessionId, direction, content, source: options?.source, metadata: options?.metadata }
  );

  if (!result.success) {
    throw new Error(`Failed to insert message: ${result.error}`);
  }

  return result.id;
}

/**
 * Insert a user prompt message (simulates user sending a message)
 */
export async function insertUserPrompt(
  page: Page,
  sessionId: string,
  prompt: string
): Promise<string> {
  const content = JSON.stringify({ prompt, options: {} });
  return await insertMessage(page, sessionId, 'input', content, { source: 'claude-code' });
}

/**
 * Insert a text response from the assistant
 */
export async function insertAssistantText(
  page: Page,
  sessionId: string,
  text: string
): Promise<string> {
  const content = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }]
    }
  });
  return await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
}

/**
 * Insert a pending AskUserQuestion prompt
 */
export async function insertPendingAskUserQuestion(
  page: Page,
  sessionId: string,
  questions: Question[]
): Promise<InsertResult> {
  const questionId = `question-${generateUUID()}`;
  const content = createAskUserQuestionMessage(questionId, questions);
  const messageId = await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
  return { id: questionId, messageId };
}

/**
 * Insert an AskUserQuestion result (marks as completed)
 */
export async function insertAskUserQuestionResult(
  page: Page,
  sessionId: string,
  questionId: string,
  answers: Record<string, string>,
  cancelled = false
): Promise<string> {
  const content = createAskUserQuestionResultMessage(questionId, answers, cancelled);
  return await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
}

// ============================================================
// RequestUserInput
// ============================================================

export interface RequestUserInputArgsForTest {
  title?: string;
  intro?: string;
  fields: Array<Record<string, any>>;
  submitLabel?: string;
  cancelLabel?: string;
}

/**
 * Generate an MCP tool_use message for PromptForUserInput.
 * Persisted as the SDK-style tool_use envelope so the canonical transformer
 * picks it up and the widget renders.
 *
 * Wire-name is `PromptForUserInput` (not `RequestUserInput`) to avoid colliding
 * with Codex CLI's built-in `request_user_input` tool gated to Plan mode.
 */
export function createRequestUserInputMessage(
  toolId: string,
  args: RequestUserInputArgsForTest,
): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: toolId,
        name: 'mcp__nimbalyst-mcp__PromptForUserInput',
        input: args,
      }],
    },
  });
}

/**
 * Generate a tool_result message for RequestUserInput
 */
export function createRequestUserInputResultMessage(
  toolId: string,
  answers: Record<string, unknown>,
  cancelled = false,
): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: JSON.stringify({ answers, cancelled }) }],
      }],
    },
  });
}

/**
 * Insert a pending RequestUserInput prompt
 */
export async function insertPendingRequestUserInput(
  page: Page,
  sessionId: string,
  args: RequestUserInputArgsForTest,
): Promise<InsertResult> {
  const toolId = `toolu_${generateUUID().replace(/-/g, '')}`;
  const content = createRequestUserInputMessage(toolId, args);
  const messageId = await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
  return { id: toolId, messageId };
}

/**
 * Insert a RequestUserInput result (marks as completed)
 */
export async function insertRequestUserInputResult(
  page: Page,
  sessionId: string,
  toolId: string,
  answers: Record<string, unknown>,
  cancelled = false,
): Promise<string> {
  const content = createRequestUserInputResultMessage(toolId, answers, cancelled);
  return await insertMessage(page, sessionId, 'input', content, { source: 'claude-code' });
}

/**
 * Insert a pending ExitPlanMode prompt
 */
export async function insertPendingExitPlanMode(
  page: Page,
  sessionId: string,
  planFilePath?: string
): Promise<InsertResult> {
  const toolId = `toolu_${generateUUID().replace(/-/g, '')}`;
  const content = createExitPlanModeMessage(toolId, planFilePath);
  const messageId = await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
  return { id: toolId, messageId };
}

/**
 * Insert an ExitPlanMode result
 */
export async function insertExitPlanModeResult(
  page: Page,
  sessionId: string,
  toolId: string,
  approved: boolean,
  feedback?: string
): Promise<string> {
  const content = createExitPlanModeResultMessage(toolId, approved, feedback);
  return await insertMessage(page, sessionId, 'input', content, { source: 'claude-code' });
}

/**
 * Insert a pending ToolPermission prompt
 */
export async function insertPendingToolPermission(
  page: Page,
  sessionId: string,
  toolName: string,
  rawCommand: string,
  pattern: string,
  options?: { isDestructive?: boolean; warnings?: string[] }
): Promise<InsertResult> {
  const requestId = `tool-${generateUUID().slice(0, 8)}`;
  const content = createToolPermissionMessage(requestId, toolName, rawCommand, pattern, options);
  const messageId = await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
  return { id: requestId, messageId };
}

/**
 * Insert a ToolPermission result
 */
export async function insertToolPermissionResult(
  page: Page,
  sessionId: string,
  requestId: string,
  decision: 'allow' | 'deny',
  scope: 'once' | 'session' | 'always' | 'always-all'
): Promise<string> {
  const content = createToolPermissionResultMessage(requestId, decision, scope);
  return await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
}

/**
 * Insert a pending GitCommitProposal prompt
 */
export async function insertPendingGitCommitProposal(
  page: Page,
  sessionId: string,
  files: string[],
  commitMessage: string,
  reasoning?: string
): Promise<InsertResult> {
  const toolId = `toolu_${generateUUID().replace(/-/g, '')}`;
  const content = createGitCommitProposalMessage(toolId, files, commitMessage, reasoning);
  const messageId = await insertMessage(page, sessionId, 'output', content, { source: 'claude-code' });
  return { id: toolId, messageId };
}

/**
 * Insert a GitCommitProposal result
 */
export async function insertGitCommitProposalResult(
  page: Page,
  sessionId: string,
  toolId: string,
  action: 'committed' | 'cancelled',
  commitHash?: string
): Promise<string> {
  const content = createGitCommitProposalResultMessage(toolId, action, commitHash);
  return await insertMessage(page, sessionId, 'input', content, { source: 'claude-code' });
}

/**
 * Clean up test sessions for a workspace
 */
export async function cleanupTestSessions(page: Page, workspacePath: string): Promise<void> {
  await page.evaluate(async (workspacePath) => {
    return await (window as any).electronAPI.invoke('test:clear-test-sessions', workspacePath);
  }, workspacePath);
}

/**
 * Navigate to a session in the UI (opens agent mode and selects the session)
 */
export async function navigateToSession(page: Page, sessionId: string): Promise<void> {
  // Click on the session in the session list
  // This requires the session to be visible in the list
  await page.click(`[data-session-id="${sessionId}"]`);
  await page.waitForTimeout(500);
}

/**
 * Refresh the session list to pick up new sessions
 */
export async function refreshSessionList(page: Page): Promise<void> {
  // Trigger refresh via keyboard shortcut or UI action
  // For now, just wait for the UI to update
  await page.waitForTimeout(300);
}

// ============================================================
// Widget Interaction Helpers
// ============================================================

// --- AskUserQuestion ---

/**
 * Wait for an AskUserQuestion widget to appear
 */
export async function waitForAskUserQuestion(page: Page, timeout = 5000): Promise<void> {
  await page.waitForSelector(INTERACTIVE_PROMPT_SELECTORS.askUserQuestionWidget, { timeout });
}

/**
 * Select an option in an AskUserQuestion widget by label
 */
export async function selectAskUserQuestionOption(page: Page, optionLabel: string): Promise<void> {
  const widget = page.locator(INTERACTIVE_PROMPT_SELECTORS.askUserQuestionWidget);
  // Find option button that contains the label
  const option = widget.locator(`button:has-text("${optionLabel}")`);
  await option.click();
}

/**
 * Submit AskUserQuestion answers
 */
export async function submitAskUserQuestion(page: Page): Promise<void> {
  const submitButton = page.locator(INTERACTIVE_PROMPT_SELECTORS.askUserQuestionSubmitButton);
  await expect(submitButton).toBeEnabled();
  await submitButton.click();
  await page.waitForTimeout(300);
}

/**
 * Cancel an AskUserQuestion
 */
export async function cancelAskUserQuestion(page: Page): Promise<void> {
  const cancelButton = page.locator(INTERACTIVE_PROMPT_SELECTORS.askUserQuestionCancelButton);
  await cancelButton.click();
  await page.waitForTimeout(300);
}

/**
 * Verify AskUserQuestion is in pending state
 */
export async function verifyAskUserQuestionPending(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.askUserQuestionPendingState)).toBeVisible();
}

/**
 * Verify AskUserQuestion is in completed state
 */
export async function verifyAskUserQuestionCompleted(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.askUserQuestionCompletedState)).toBeVisible();
}

/**
 * Verify AskUserQuestion is in cancelled state
 */
export async function verifyAskUserQuestionCancelled(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.askUserQuestionCancelledState)).toBeVisible();
}

// --- ExitPlanMode ---

/**
 * Wait for an ExitPlanMode widget to appear
 */
export async function waitForExitPlanMode(page: Page, timeout = 5000): Promise<void> {
  await page.waitForSelector(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeWidget, { timeout });
}

/**
 * Approve ExitPlanMode (simple approve, same session)
 */
export async function approveExitPlanMode(page: Page): Promise<void> {
  const button = page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeApproveButton);
  await button.click();
  await page.waitForTimeout(300);
}

/**
 * Approve ExitPlanMode and start a new session
 */
export async function approveExitPlanModeNewSession(page: Page): Promise<void> {
  const button = page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeStartNewSessionButton);
  await button.click();
  await page.waitForTimeout(300);
}

/**
 * Deny ExitPlanMode with feedback
 */
export async function denyExitPlanModeWithFeedback(page: Page, feedback: string): Promise<void> {
  // Click the deny option to show feedback input
  await page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeDenyButton).click();
  await page.waitForTimeout(200);

  // Enter feedback
  const input = page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeFeedbackInput);
  await input.fill(feedback);

  // Submit feedback
  await page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeSendFeedbackButton).click();
  await page.waitForTimeout(300);
}

/**
 * Cancel ExitPlanMode
 */
export async function cancelExitPlanMode(page: Page): Promise<void> {
  const button = page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeCancelButton);
  await button.click();
  await page.waitForTimeout(300);
}

/**
 * Verify ExitPlanMode is in pending state
 */
export async function verifyExitPlanModePending(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModePendingState)).toBeVisible();
}

/**
 * Verify ExitPlanMode is in approved state
 */
export async function verifyExitPlanModeApproved(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeApprovedState)).toBeVisible();
}

/**
 * Verify ExitPlanMode is in denied state
 */
export async function verifyExitPlanModeDenied(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.exitPlanModeDeniedState)).toBeVisible();
}

// --- ToolPermission ---

/**
 * Wait for a ToolPermission widget to appear
 */
export async function waitForToolPermission(page: Page, timeout = 5000): Promise<void> {
  await page.waitForSelector(INTERACTIVE_PROMPT_SELECTORS.toolPermissionWidget, { timeout });
}

/**
 * Allow a tool permission with specified scope
 */
export async function allowToolPermission(
  page: Page,
  scope: 'once' | 'session' | 'always'
): Promise<void> {
  const selector = scope === 'once'
    ? INTERACTIVE_PROMPT_SELECTORS.toolPermissionAllowOnceButton
    : scope === 'session'
    ? INTERACTIVE_PROMPT_SELECTORS.toolPermissionAllowSessionButton
    : INTERACTIVE_PROMPT_SELECTORS.toolPermissionAllowAlwaysButton;

  const button = page.locator(selector);
  await button.click();
  await page.waitForTimeout(300);
}

/**
 * Deny a tool permission
 */
export async function denyToolPermission(page: Page): Promise<void> {
  const button = page.locator(INTERACTIVE_PROMPT_SELECTORS.toolPermissionDenyButton);
  await button.click();
  await page.waitForTimeout(300);
}

/**
 * Verify ToolPermission is in pending state
 */
export async function verifyToolPermissionPending(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.toolPermissionPendingState)).toBeVisible();
}

/**
 * Verify ToolPermission is in granted state
 */
export async function verifyToolPermissionGranted(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.toolPermissionGrantedState)).toBeVisible();
}

/**
 * Verify ToolPermission is in denied state
 */
export async function verifyToolPermissionDenied(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.toolPermissionDeniedState)).toBeVisible();
}

// --- GitCommitProposal ---

/**
 * Wait for a GitCommitProposal widget to appear
 */
export async function waitForGitCommitProposal(page: Page, timeout = 5000): Promise<void> {
  await page.waitForSelector(INTERACTIVE_PROMPT_SELECTORS.gitCommitWidget, { timeout });
}

/**
 * Toggle a file checkbox in the git commit widget
 */
export async function toggleGitCommitFile(page: Page, fileName: string): Promise<void> {
  const widget = page.locator(INTERACTIVE_PROMPT_SELECTORS.gitCommitWidget);
  const checkbox = widget.locator(`label:has-text("${fileName}") input[type="checkbox"]`);
  await checkbox.click();
}

/**
 * Edit the commit message in the git commit widget
 */
export async function editGitCommitMessage(page: Page, message: string): Promise<void> {
  const input = page.locator(INTERACTIVE_PROMPT_SELECTORS.gitCommitMessageInput);
  await input.fill(message);
}

/**
 * Confirm the git commit
 */
export async function confirmGitCommit(page: Page): Promise<void> {
  const button = page.locator(INTERACTIVE_PROMPT_SELECTORS.gitCommitConfirmButton);
  await expect(button).toBeEnabled();
  await button.click();
  await page.waitForTimeout(300);
}

/**
 * Cancel the git commit
 */
export async function cancelGitCommit(page: Page): Promise<void> {
  const button = page.locator(INTERACTIVE_PROMPT_SELECTORS.gitCommitCancelButton);
  await button.click();
  await page.waitForTimeout(300);
}

/**
 * Verify GitCommitProposal is in pending state
 */
export async function verifyGitCommitPending(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.gitCommitPendingState)).toBeVisible();
}

/**
 * Verify GitCommitProposal is in committed state
 */
export async function verifyGitCommitCommitted(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.gitCommitCommittedState)).toBeVisible();
}

/**
 * Verify GitCommitProposal is in cancelled state
 */
export async function verifyGitCommitCancelled(page: Page): Promise<void> {
  await expect(page.locator(INTERACTIVE_PROMPT_SELECTORS.gitCommitCancelledState)).toBeVisible();
}
