/**
 * AI Test Helpers
 *
 * Shared utilities for testing AI features in the Nimbalyst editor.
 * These helpers encapsulate common patterns for interacting with the AI chat,
 * agent mode, and document editing.
 */

import type { Page, ElectronApplication } from '@playwright/test';
import { expect } from '@playwright/test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TEST_TIMEOUTS } from '../helpers';

/**
 * Selectors for AI-related UI elements
 */
export const PLAYWRIGHT_TEST_SELECTORS = {
  // Mode switching
  editorModeButton: '[data-mode="files"]', // Note: "editor" mode is actually "files" mode in the UI
  agentModeButton: '[data-mode="agent"]',
  filesModeButton: '[data-mode="files"]',

  // Workspace and file tree
  workspaceSidebar: '.workspace-sidebar',
  fileTreeContainer: '.workspace-file-tree',
  fileTreeItem: '.file-tree-name',
  fileTreeFilterButton: '.workspace-action-button[aria-label="Filter files"]',
  fileTreeFilterMenu: '.file-tree-filter-menu',
  filterMenuAllFiles: '.filter-menu-item:has-text("All Files")',
  filterMenuMarkdownOnly: '.filter-menu-item:has-text("Markdown Only")',
  filterMenuKnownFiles: '.filter-menu-item:has-text("Known Files")',
  filterMenuShowIcons: '.filter-menu-item:has-text("Show Icons")',

  // Tabs (Files mode - document/session tabs at top)
  tab: '.tab',
  filesModeSessionTab: '.tab[data-tab-type="session"]', // Chat session tabs in Files mode
  documentTab: '.tab[data-tab-type="document"]',
  tabTitle: '.tab-title',
  tabDirtyIndicator: '.tab-dirty-indicator',
  tabUnacceptedIndicator: '.tab-unaccepted-indicator',
  tabProcessingIndicator: '.tab-processing-indicator',
  tabUnreadIndicator: '.tab-unread-indicator',
  fileTabsContainer: '.file-tabs-container',
  tabCloseButton: '.tab-close-button',

  // API key dialog
  apiKeyDialogOverlay: '.api-key-dialog-overlay',
  apiKeyDialogDismissButton: '.api-key-dialog-button.secondary',

  // Discord invitation overlay (appears after N launches, intercepts pointer events)
  discordInvitationOverlay: '.discord-invitation-overlay',

  // AI Chat
  aiChatPanel: '[data-testid="chat-sidebar-panel"]',
  chatInput: 'textarea.ai-chat-input-field', // DEPRECATED: ambiguous - matches both Files mode and Agent mode. Use filesChatInput or agentChatInput instead.
  filesChatInput: '[data-testid="files-mode-chat-input"]',
  agentChatInput: '[data-testid="agent-mode-chat-input"]',
  newSessionButton: '[data-testid="new-session-button"]',
  noSessionSelected: 'text="No session selected"',

  // Active session panel (contains the transcript and input for the current session)
  activeSession: '.agent-session-panel',

  // Attachments
  attachmentPreview: '.attachment-preview',
  attachmentFilename: '.attachment-preview-filename',
  attachmentRemoveButton: '.attachment-preview-remove',

  // Diff approval (Unified Diff Header - used by Lexical, Monaco, and custom editors)
  diffAcceptButton: '.unified-diff-header-button-accept-single', // Per-change "Keep" button
  diffRejectButton: '.unified-diff-header-button-reject-single', // Per-change "Revert" button
  diffAcceptAllButton: '[data-testid="diff-keep-all"]', // "Keep All" button
  diffRejectAllButton: '[data-testid="diff-revert-all"]', // "Revert All" button
  acceptAllButton: '[data-testid="diff-keep-all"]', // Alias for compatibility
  rejectAllButton: '[data-testid="diff-revert-all"]', // Alias for compatibility
  diffApprovalBar: '.unified-diff-header', // Unified diff header bar
  unifiedDiffHeader: '.unified-diff-header', // Same as diffApprovalBar
  unifiedDiffAcceptAllButton: '[data-testid="diff-keep-all"]',
  unifiedDiffRejectAllButton: '[data-testid="diff-revert-all"]',
  diffChangeCounter: '.unified-diff-header-change-counter',

  // Monaco diff approval (Code files)
  monacoDiffApprovalBar: '.monaco-diff-approval-bar',
  monacoDiffApprovalBarLabel: '.monaco-diff-approval-bar-label',
  monacoDiffAcceptButton: '.monaco-diff-approval-bar-button-accept',
  monacoDiffRejectButton: '.monaco-diff-approval-bar-button-reject',
  monacoDiffEditor: '.monaco-diff-editor',

  // Transcript elements
  richTranscriptMessage: '.rich-transcript-message',
  richTranscriptToolContainer: '.rich-transcript-tool-container',

  // Agent mode session tabs (horizontal tabs for multiple sessions)
  agentModeSessionTabsContainer: '.ai-session-tabs-container',
  agentModeSessionTab: '.ai-session-tabs-container .tab',

  // Session history (agent mode sidebar)
  sessionHistory: '.session-history',
  sessionHistoryItem: '.session-history-item',
  sessionHistoryList: '.session-history-list',
  sessionHistoryNewButton: '.session-history-new-button', // The dropdown trigger button
  sessionHistoryNewMenu: '.session-history-new-menu', // The dropdown menu itself
  newDropdownButton: '[data-testid="new-dropdown-button"]', // More specific selector for dropdown trigger
  newSessionButton: '[data-testid="new-session-button"]', // Menu item for new session
  newWorktreeSessionButton: '[data-testid="new-worktree-session-button"]', // Menu item for new worktree
  sessionListItem: '[data-testid="session-list-item"]', // Regular (non-worktree, non-workstream) sessions
  sessionListItemTitle: '.session-list-item-title',

  // Agent mode container
  agentMode: '.agent-mode',

  // All session items in sidebar (any type - regular, worktree, workstream)
  anySessionItem: '.session-list-item',

  // Workstream session tabs (child sessions within a workstream)
  sessionTabBar: '.session-tab-bar',
  sessionTabInWorkstream: '.session-tab',
  sessionTabActive: '.session-tab.active',
  sessionTabNew: '.session-tab-new',
  sessionTabTitle: '.session-tab-title',
  workstreamGroup: '[data-testid="workstream-group"]',
  workstreamChildItem: '[data-testid="workstream-child-item"]',
  workstreamGroupName: '.workstream-group-name',
  sessionListItemRight: '.session-list-item-right',
  sessionListItemStatusUnread: '.session-list-item-status.unread',

  // Worktree sessions
  worktreeGroup: '[data-testid="worktree-group"]',
  worktreeSessionItem: '[data-testid="worktree-session-item"]', // Single-session worktree (flat item)

  // Session containers
  sessionContainer: '[data-session-id]',

  // Editor
  contentEditable: '[contenteditable="true"]',

  // History dialog
  historyDialog: '.history-dialog',
  historyItem: '.history-item',
  historyPreviewContent: '.history-preview-content',
  historyPreviewPre: '.history-preview-content pre',
  historyRestoreButton: '.history-restore-button',

  // File context menu
  fileContextMenu: '[data-testid="file-context-menu"]',
  fileContextMenuItem: '.file-context-menu-item',
  fileContextMenuDelete: '[data-testid="context-menu-delete"]',

  // Search/Replace bar
  searchReplaceBar: '[data-testid="search-replace-bar"]',
  searchInput: '[data-testid="search-input"]',
  replaceInput: '[data-testid="replace-input"]',
  caseToggle: '[data-testid="case-toggle"]',
  regexToggle: '[data-testid="regex-toggle"]',
  matchCounter: '[data-testid="match-counter"]',

  // Trust/Permissions
  trustIndicator: '.trust-indicator',
  trustIndicatorTrusted: '.trust-indicator.trusted',
  trustIndicatorUntrusted: '.trust-indicator.untrusted',
  trustMenu: '.trust-menu',
  trustToast: '.project-trust-toast',
  trustToastOverlay: '.project-trust-toast-overlay',
  trustToastModeBtn: '.project-trust-toast-mode-btn',
  trustToastSmartPermissions: '.project-trust-toast-mode-btn:has-text("Smart Permissions")',
  trustToastAlwaysAllow: '.project-trust-toast-mode-btn:has-text("Always Allow")',
  trustToastSaveButton: '.project-trust-toast-save',
  trustToastCancelButton: '.project-trust-toast-cancel',
  trustToastDontTrustButton: '.project-trust-toast-dont-trust',

  // Permission confirmation (inline tool permission request)
  permissionConfirmation: '.tool-permission-confirmation',
  permissionConfirmationTitle: '.tool-permission-confirmation-title',
  permissionConfirmationCommand: '.tool-permission-confirmation-current-action-command',
  permissionConfirmationDenyButton: '.tool-permission-confirmation-button--deny',
  permissionConfirmationAllowOnceButton: '.tool-permission-confirmation-button--once',
  permissionConfirmationAllowSessionButton: '.tool-permission-confirmation-button--session',
  permissionConfirmationAllowAlwaysButton: '.tool-permission-confirmation-button--always',
  permissionConfirmationWarning: '.tool-permission-confirmation-warning',

  // Settings view
  settingsView: '.settings-view',
  settingsViewHeader: '.settings-view-header',
  settingsViewTitle: '.settings-view-title',
  settingsScopeTabUser: '.settings-scope-tab:has-text("User")',
  settingsScopeTabProject: '.settings-scope-tab:has-text("Project")',
  settingsSidebarItem: '.settings-category-item',
  settingsSidebarItemAgentPermissions: '.settings-category-item:has-text("Agent Permissions")',
  settingsPanelContent: '.settings-panel-content',
  settingsPanelHeader: '.settings-panel-header',

  // Agent Permissions panel
  permissionsUrlList: '.permissions-url-list',
  permissionsUrlItem: '.permissions-url-item',
  permissionsUrlPattern: '.permissions-url-pattern',
  permissionsEmptyState: '.permissions-empty-state',
  permissionsPatternList: '.permissions-pattern-list',
  permissionsPatternItem: '.permissions-pattern-item',
  permissionsPatternName: '.permissions-pattern-name',

  // Walkthrough Guide System
  walkthroughCallout: '.walkthrough-callout',
  walkthroughCalloutTitle: '.walkthrough-callout-title',
  walkthroughCalloutBody: '.walkthrough-callout-body',
  walkthroughCalloutProgress: '.walkthrough-callout-progress',
  walkthroughCalloutDismiss: '.walkthrough-callout-dismiss',
  walkthroughCalloutNextButton: '.walkthrough-callout-btn--next',
  walkthroughCalloutBackButton: '.walkthrough-callout-btn--back',
  walkthroughCalloutDoneButton: '.walkthrough-callout-btn--done',

  // Walkthrough targets (buttons with data-testid)
  fileTreeFilterButtonTestId: '[data-testid="file-tree-filter-button"]',
  fileTreeQuickOpenButton: '[data-testid="file-tree-quick-open-button"]',
  aiSessionsButton: '[data-testid="ai-sessions-button"]',

  // Git Operations Panel (Agent Mode)
  gitOperationsPanel: '.git-operations-panel',
  gitOperationsSmartMode: '[data-testid="git-operations-smart-mode"]',
  gitOperationsCommitWithAiButton: '[data-testid="git-operations-commit-with-ai-button"]',
  gitOperationsCommitButton: '[data-testid="git-operations-commit-button"]',
  gitOperationsCommitMessage: '[data-testid="git-operations-commit-message"]',

  // Tracker Mode
  trackerSidebar: '[data-testid="tracker-sidebar"]',
  trackerTable: '[data-testid="tracker-table"]',
  trackerTableRow: '[data-testid="tracker-table-row"]',
  trackerTypeButton: '[data-testid="tracker-type-button"]',
  trackerToolbarNewButton: '[data-testid="tracker-toolbar-new-button"]',
  trackerQuickAddInput: '[data-testid="tracker-quick-add-input"]',
  trackerItemDetail: '[data-testid="tracker-item-detail"]',
  trackerDetailTitle: '[data-testid="tracker-detail-title"]',
  trackerSourceDbBadge: '[data-testid="tracker-source-db-badge"]',
  customSelectOption: '.custom-select-option',

  // Session Kanban Board
  sessionKanbanBoard: '[data-testid="session-kanban-board"]',
  kanbanColumn: '[data-testid="session-kanban-column"]',
  kanbanCard: '[data-testid="session-kanban-card"]',
  kanbanToolbar: '[data-testid="kanban-toolbar"]',
  kanbanSearch: '[data-testid="kanban-search"]',
  kanbanToggleComplete: '[data-testid="kanban-toggle-complete"]',
  kanbanEmptyState: '[data-testid="kanban-empty-state"]',
  trackerViewSessions: '[data-testid="tracker-view-sessions"]',
  trackerModeButton: '[data-testid="tracker-mode-button"]',

  // Document Header / Tracker
  documentHeaderContainer: '.document-header-container',
  statusBar: '.status-bar',
  statusBarHeader: '.status-bar-header',
  statusBarField: '.status-bar-field',
  sliderNumberInput: '.slider-number-input',
  customSelect: '.custom-select',
  customSelectTrigger: '.custom-select-trigger',
  customSelectValue: '.custom-select-value',
};

/**
 * Create a new document in the workspace and open it in edit mode
 */
export async function openNewDocument(
  page: Page,
  workspaceDir: string,
  fileName: string,
  contents: string
): Promise<string> {
  const filePath = path.join(workspaceDir, fileName);

  // Write file to disk BEFORE opening (critical for file tree to detect it)
  await fs.writeFile(filePath, contents, 'utf8');

  // Click on file in file tree to open it
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: fileName }).click();
  await page.waitForTimeout(500);

  // Verify tab appeared
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.tabTitle, { hasText: fileName }))
    .toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });

  return filePath;
}

/**
 * Switch to Files mode
 */
export async function switchToFilesMode(page: Page): Promise<void> {
  // Check if already in Files mode (sidebar visible) to avoid toggling away
  const sidebarVisible = await page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar)
    .isVisible().catch(() => false);
  if (sidebarVisible) return;

  const filesModeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton);
  await filesModeButton.click();
  await page.waitForTimeout(500);

  // Wait for workspace sidebar to be visible
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar, { timeout: 5000 });
}

/**
 * Switch to Editor mode
 */
export async function switchToEditorMode(page: Page): Promise<void> {
  const editorModeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.editorModeButton);
  await editorModeButton.click();
  await page.waitForTimeout(1000); // Give mode switch time to complete
}

/**
 * Switch to Agent mode
 * Note: This auto-creates the first session if none exists
 * Idempotent: safe to call when already in agent mode
 */
export async function switchToAgentMode(page: Page): Promise<void> {
  const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
  const isAlreadyVisible = await agentMode.isVisible().catch(() => false);

  if (!isAlreadyVisible) {
    const agentModeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentModeButton);
    await agentModeButton.click();
    await page.waitForTimeout(1500); // Wait for mode switch, UI to settle, and auto-session selection
  }
}

/**
 * Switch to Meta Agent mode.
 * @deprecated Meta-agent is now a session type in the agent panel, not a separate mode.
 * This just switches to agent mode for backward compatibility.
 */
export async function switchToMetaAgentMode(page: Page): Promise<void> {
  await switchToAgentMode(page);
}

/**
 * Submit a chat prompt in the currently active session.
 * Uses data-testid selectors to unambiguously target the correct chat input
 * (Agent mode vs Files mode), since both are always in the DOM.
 */
export async function submitChatPrompt(
  page: Page,
  promptText: string,
  options: { waitForResponse?: boolean; timeout?: number } = {}
): Promise<void> {
  const { waitForResponse = false, timeout = 15000 } = options;

  // Use the correct data-testid selector based on which mode is visible
  const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
  const isAgentModeVisible = await agentMode.isVisible().catch(() => false);

  const chatInput = isAgentModeVisible
    ? page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput)
    : page.locator(PLAYWRIGHT_TEST_SELECTORS.filesChatInput);
  await chatInput.waitFor({ state: 'visible', timeout: 5000 });

  // Fill the message (more reliable than type() for React inputs)
  await chatInput.fill(promptText);
  await page.waitForTimeout(100); // Brief wait to ensure React state updates

  // Send message with Enter key
  await chatInput.press('Enter');

  if (waitForResponse) {
    // Wait for AI to respond (look for tool calls or messages)
    await page.waitForTimeout(timeout);
  }
}

/**
 * Select the first session from session history
 * Use this after switching to Agent mode to activate an existing session
 */
export async function selectFirstSession(page: Page): Promise<void> {
  const sessionHistory = page.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistory);
  const firstSession = sessionHistory.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistoryItem).first();
  await firstSession.waitFor({ state: 'visible', timeout: 3000 });
  await firstSession.click();
  await page.waitForTimeout(500);
}

/**
 * Create a new agent session
 * Scopes to session-history sidebar to avoid clicking chat mode button
 */
export async function createNewAgentSession(page: Page): Promise<void> {
  // Scope to agent mode to avoid clicking Files mode elements
  const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
  const agentSidebar = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistory);
  const newSessionButton = agentSidebar.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistoryNewButton);
  await newSessionButton.click({ timeout: 5000 });

  // The button may open a dropdown if multiple options are available.
  // If a dropdown appeared, click "New Session" inside it.
  const dropdown = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistoryNewMenu);
  const newSessionItem = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.newSessionButton);
  if (await dropdown.isVisible({ timeout: 300 }).catch(() => false)) {
    await newSessionItem.click({ timeout: 2000 });
  }
  await page.waitForTimeout(500);
}

/**
 * Switch to a specific Agent mode session tab by index (0-based)
 */
export async function switchToSessionTab(page: Page, index: number): Promise<void> {
  const sessionTabs = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentModeSessionTab);
  const targetTab = sessionTabs.nth(index);
  await targetTab.click();
  await page.waitForTimeout(500);
}

/**
 * Get the active session's transcript container
 */
export function getActiveSession(page: Page) {
  return page.locator(PLAYWRIGHT_TEST_SELECTORS.activeSession);
}

/**
 * Wait for tool calls to appear in the active session
 */
export async function waitForToolCalls(
  page: Page,
  options: { timeout?: number; minCount?: number } = {}
): Promise<void> {
  const { timeout = 10000, minCount = 1 } = options;

  const activeSession = getActiveSession(page);
  const toolCalls = activeSession.locator(PLAYWRIGHT_TEST_SELECTORS.richTranscriptToolContainer);

  // Wait for at least minCount tool calls
  await expect(toolCalls.first()).toBeVisible({ timeout });

  if (minCount > 1) {
    await expect(toolCalls).toHaveCount(minCount, { timeout });
  }
}

/**
 * Wait for messages to appear in the active session
 */
export async function waitForMessages(
  page: Page,
  options: { timeout?: number; minCount?: number } = {}
): Promise<void> {
  const { timeout = 10000, minCount = 1 } = options;

  const activeSession = getActiveSession(page);
  const messages = activeSession.locator(PLAYWRIGHT_TEST_SELECTORS.richTranscriptMessage);

  await expect(messages.first()).toBeVisible({ timeout });

  if (minCount > 1) {
    await expect(messages).toHaveCount(minCount, { timeout });
  }
}

/**
 * Check if the active session has tool calls
 */
export async function hasToolCalls(page: Page): Promise<boolean> {
  const activeSession = getActiveSession(page);
  const count = await activeSession.locator(PLAYWRIGHT_TEST_SELECTORS.richTranscriptToolContainer).count();
  return count > 0;
}

/**
 * Check if the active session has messages
 */
export async function hasMessages(page: Page): Promise<boolean> {
  const activeSession = getActiveSession(page);
  const count = await activeSession.locator(PLAYWRIGHT_TEST_SELECTORS.richTranscriptMessage).count();
  return count > 0;
}

/**
 * Get the number of Agent mode session tabs
 */
export async function getSessionTabCount(page: Page): Promise<number> {
  return await page.locator(PLAYWRIGHT_TEST_SELECTORS.agentModeSessionTab).count();
}

/**
 * Verify a document was edited and saved to disk
 */
export async function verifyDocumentEdited(
  filePath: string,
  expectedContent: string | RegExp
): Promise<void> {
  const content = await fs.readFile(filePath, 'utf8');

  if (typeof expectedContent === 'string') {
    expect(content).toContain(expectedContent);
  } else {
    expect(content).toMatch(expectedContent);
  }
}

/**
 * Switch to a specific document tab by name
 */
export async function switchToDocumentTab(page: Page, fileName: string): Promise<void> {
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.tab, { hasText: fileName }).click();
  await page.waitForTimeout(500);
}

/**
 * Setup a basic AI test scenario with workspace and documents
 */
export async function setupAITest(
  workspaceDir: string,
  documents: Array<{ fileName: string; content: string }>
): Promise<Map<string, string>> {
  const filePaths = new Map<string, string>();

  for (const doc of documents) {
    const filePath = path.join(workspaceDir, doc.fileName);
    await fs.writeFile(filePath, doc.content, 'utf8');
    filePaths.set(doc.fileName, filePath);
  }

  return filePaths;
}

/**
 * Open multiple documents in sequence
 */
export async function openDocuments(
  page: Page,
  fileNames: string[]
): Promise<void> {
  for (const fileName of fileNames) {
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: fileName }).click();
    await page.waitForTimeout(300);

    // Verify tab appeared
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.tabTitle, { hasText: fileName }))
      .toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });
  }
}

/**
 * Complete AI workflow: switch to agent mode, submit prompt, wait for response
 */
export async function runAgenticWorkflow(
  page: Page,
  prompt: string,
  options: {
    createNewSession?: boolean;
    waitTimeout?: number;
    expectToolCalls?: boolean;
  } = {}
): Promise<void> {
  const {
    createNewSession = false,
    waitTimeout = 15000,
    expectToolCalls = true
  } = options;

  // Switch to agent mode if not already there
  await switchToAgentMode(page);

  // Create new session if requested
  if (createNewSession) {
    await createNewAgentSession(page);
  }

  // Submit prompt
  await submitChatPrompt(page, prompt);

  // Wait for response
  await page.waitForTimeout(waitTimeout);

  // Verify expected content appeared
  if (expectToolCalls) {
    await waitForToolCalls(page, { timeout: 10000 });
  } else {
    await waitForMessages(page, { timeout: 10000 });
  }
}

/**
 * Type aliases for common test patterns
 */
export interface AITestDocument {
  fileName: string;
  content: string;
}

export interface AITestSession {
  prompt: string;
  expectedDocumentEdits?: string[];
  expectToolCalls?: boolean;
}

/**
 * Dismiss API key dialog if present
 */
export async function dismissAPIKeyDialog(page: Page): Promise<void> {
  try {
    const apiDialog = page.locator(PLAYWRIGHT_TEST_SELECTORS.apiKeyDialogOverlay);
    // Use a short timeout to check visibility
    const isVisible = await apiDialog.isVisible().catch(() => false);
    if (isVisible) {
      await page.locator(PLAYWRIGHT_TEST_SELECTORS.apiKeyDialogDismissButton).click();
    }
  } catch {
    // Dialog not present or already dismissed
  }
}

/**
 * Wait for workspace sidebar and file tree to load
 */
export async function waitForWorkspaceReady(page: Page): Promise<void> {
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar, {
    timeout: TEST_TIMEOUTS.SIDEBAR_LOAD
  });
}

/**
 * Open a file by path using the app's internal file selection handler.
 * Works regardless of file tree virtualization or scroll position.
 *
 * The fileName can be just the filename (resolved against workspace) or a full path.
 */
export async function openFileFromTree(
  page: Page,
  fileName: string
): Promise<void> {
  // Resolve to absolute path if needed, then open via the app's own handler
  await page.evaluate(async (name) => {
    const workspace = (window as any).__workspacePath;
    const isAbsolute = name.startsWith('/');
    const fullPath = isAbsolute ? name : `${workspace}/${name}`;
    await (window as any).__handleWorkspaceFileSelect(fullPath);
  }, fileName);

  // Wait for tab to become active
  const displayName = fileName.includes('/') ? fileName.split('/').pop()! : fileName;
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.tab, { hasText: displayName }))
    .toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });
}

/**
 * Manual save using keyboard shortcut (Cmd+S)
 */
export async function manualSaveDocument(page: Page): Promise<void> {
  const isMac = process.platform === 'darwin';
  const saveKey = isMac ? 'Meta+s' : 'Control+s';
  await page.keyboard.press(saveKey);
  await page.waitForTimeout(TEST_TIMEOUTS.SAVE_OPERATION);
}

/**
 * Wait for autosave to complete (dirty indicator disappears)
 */
export async function waitForAutosave(
  page: Page,
  fileName: string,
  timeout: number = 3000
): Promise<void> {
  const tab = page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTabsContainer).locator(PLAYWRIGHT_TEST_SELECTORS.tab, {
    has: page.locator(PLAYWRIGHT_TEST_SELECTORS.tabTitle, { hasText: fileName })
  });

  // Wait for dirty indicator to appear
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 1000 });

  // Wait for autosave (2s interval + 200ms debounce + buffer)
  await page.waitForTimeout(timeout);

  // Verify dirty indicator is gone
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0, { timeout: 1000 });
}

/**
 * Open history dialog using keyboard shortcut (Cmd+Y)
 */
export async function openHistoryDialog(page: Page): Promise<void> {
  // Click body to ensure we're not focused in editor
  await page.click('body');
  await page.waitForTimeout(200);

  // Press keyboard shortcut
  const isMac = process.platform === 'darwin';
  const historyKey = isMac ? 'Meta+y' : 'Control+y';
  await page.keyboard.press(historyKey);

  // Wait for dialog to appear
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.historyDialog, { timeout: 5000 });
}

/**
 * Select a history item by index and wait for preview
 */
export async function selectHistoryItem(
  page: Page,
  index: number
): Promise<void> {
  const historyItems = page.locator(PLAYWRIGHT_TEST_SELECTORS.historyItem);
  await historyItems.nth(index).click();
  await page.waitForTimeout(500);
}

/**
 * Get history item count
 */
export async function getHistoryItemCount(page: Page): Promise<number> {
  return await page.locator(PLAYWRIGHT_TEST_SELECTORS.historyItem).count();
}

/**
 * Find history item by content match
 */
export async function findHistoryItemByContent(
  page: Page,
  searchText: string
): Promise<number> {
  const historyItems = page.locator(PLAYWRIGHT_TEST_SELECTORS.historyItem);
  const itemCount = await historyItems.count();

  for (let i = 0; i < itemCount; i++) {
    await historyItems.nth(i).click();
    await page.waitForTimeout(300);

    const previewContent = page.locator(PLAYWRIGHT_TEST_SELECTORS.historyPreviewContent);
    const preview = await previewContent.innerText().catch(() => '');

    if (preview.includes(searchText)) {
      return i;
    }
  }

  return -1;
}

/**
 * Restore from selected history item
 */
export async function restoreFromHistory(page: Page): Promise<void> {
  const restoreButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.historyRestoreButton);
  await restoreButton.waitFor({ state: 'visible', timeout: 5000 });
  await expect(restoreButton).toBeEnabled({ timeout: 5000 });
  await restoreButton.click();
  await page.waitForTimeout(500);
}

/**
 * Edit document content (select all and type new content)
 */
export async function editDocumentContent(
  page: Page,
  editorLocator: any,
  content: string
): Promise<void> {
  await editorLocator.click();
  const isMac = process.platform === 'darwin';
  const selectAllKey = isMac ? 'Meta+a' : 'Control+a';
  await page.keyboard.press(selectAllKey);
  await page.keyboard.type(content);
  await page.waitForTimeout(200);
}

/**
 * Open AI Chat panel and create a session if needed
 * This is the CORRECT way to set up AI Chat for tests
 */
export async function openAIChatWithSession(page: Page): Promise<void> {
  // Check if AI Chat is already visible
  const aiChatVisible = await page.locator(PLAYWRIGHT_TEST_SELECTORS.aiChatPanel)
    .isVisible()
    .catch(() => false);

  if (!aiChatVisible) {
    // Open AI Chat panel using keyboard shortcut
    const isMac = process.platform === 'darwin';
    const chatKey = isMac ? 'Meta+Shift+A' : 'Control+Shift+A';
    await page.keyboard.press(chatKey);
    await page.waitForTimeout(500);
  }

  // Create a new session if needed (filter to visible to avoid clicking hidden buttons)
  const newSessionButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.newSessionButton).filter({ hasText: /New|Start/i }).first();
  const needsSession = await newSessionButton.isVisible().catch(() => false);

  if (needsSession) {
    await newSessionButton.click();
    await page.waitForTimeout(1000);
  }

  // Wait for chat input to be visible in the Files mode AI chat panel
  const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesChatInput);
  await chatInput.waitFor({ state: 'visible', timeout: 3000 });
}

/**
 * Close a tab by filename
 * Uses data-filename attribute for reliable identification
 */
export async function closeTabByFileName(page: Page, fileName: string): Promise<void> {
  // Find the tab with the matching filename
  const tab = page.locator(PLAYWRIGHT_TEST_SELECTORS.tab, { has: page.locator(`[data-filename="${fileName}"]`) });

  // Make sure tab exists
  await expect(tab).toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });

  // Click the close button for this tab
  const closeButton = tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabCloseButton);
  await closeButton.click();

  // Wait for tab to disappear
  await expect(tab).not.toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await page.waitForTimeout(300);
}

/**
 * Get a tab locator by filename
 * Uses data-filename attribute for reliable identification
 */
export function getTabByFileName(page: Page, fileName: string) {
  return page.locator(PLAYWRIGHT_TEST_SELECTORS.tab, { has: page.locator(`[data-filename="${fileName}"]`) });
}

/**
 * Check if a tab with the given filename is visible
 */
export async function isTabVisible(page: Page, fileName: string): Promise<boolean> {
  const tab = getTabByFileName(page, fileName);
  return await tab.isVisible().catch(() => false);
}

/**
 * Trust workspace with Smart Permissions mode via the trust toast
 * Use this at the start of tests that need a trusted workspace
 */
export async function trustWorkspaceSmartPermissions(page: Page): Promise<void> {
  const trustToast = page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToast);

  // Wait for toast to appear (it shows for new untrusted workspaces)
  try {
    await expect(trustToast).toBeVisible({ timeout: 5000 });
  } catch {
    // Toast may have already been dismissed or workspace already trusted
    return;
  }

  // Smart Permissions is selected by default, but click it to be sure
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToastSmartPermissions).click();
  await page.waitForTimeout(300);

  // Click "Trust Project" to save the selection
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToastSaveButton).click();
  await page.waitForTimeout(500);

  // Wait for toast to dismiss
  await expect(trustToast).not.toBeVisible({ timeout: 3000 });
}

/**
 * Trust workspace with Always Allow mode via the trust toast
 * Use this at the start of tests that need unrestricted agent access
 */
export async function trustWorkspaceAlwaysAllow(page: Page): Promise<void> {
  const trustToast = page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToast);

  // Wait for toast to appear (it shows for new untrusted workspaces)
  try {
    await expect(trustToast).toBeVisible({ timeout: 5000 });
  } catch {
    // Toast may have already been dismissed or workspace already trusted
    return;
  }

  // Click Always Allow option to select it
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToastAlwaysAllow).click();
  await page.waitForTimeout(300);

  // Click "Trust Project" to save the selection
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToastSaveButton).click();
  await page.waitForTimeout(500);

  // Wait for toast to dismiss
  await expect(trustToast).not.toBeVisible({ timeout: 3000 });
}

/**
 * Dismiss trust toast without trusting (click outside)
 */
export async function dismissTrustToast(page: Page): Promise<void> {
  const trustToast = page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToast);

  const isVisible = await trustToast.isVisible().catch(() => false);
  if (!isVisible) {
    return;
  }

  // Click outside the toast on the overlay
  const overlay = page.locator(PLAYWRIGHT_TEST_SELECTORS.trustToastOverlay);
  await overlay.click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(500);

  await expect(trustToast).not.toBeVisible({ timeout: 3000 });
}

/**
 * Open Agent Permissions settings panel via the Settings view
 * Uses test helpers exposed on window to navigate to settings
 */
export async function openAgentPermissionsSettings(page: Page): Promise<void> {
  // Use test helpers to navigate to settings view with Agent Permissions selected
  await page.evaluate(() => {
    const helpers = (window as any).__testHelpers;
    if (helpers && helpers.openAgentPermissions) {
      helpers.openAgentPermissions();
    }
  });

  // Wait for settings view to be visible
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.settingsView, { timeout: 5000 });
  await page.waitForTimeout(500);

  // Wait for panel content to load (permissions section header)
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.settingsPanelContent)).toBeVisible({ timeout: 3000 });
}

/**
 * Get allowed URL patterns from the Agent Permissions settings panel
 */
export async function getAllowedUrlPatterns(page: Page): Promise<string[]> {
  const urlPatterns = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionsUrlPattern);
  const count = await urlPatterns.count();

  const patterns: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await urlPatterns.nth(i).textContent();
    if (text) {
      patterns.push(text.trim());
    }
  }

  return patterns;
}

/**
 * Get allowed tool patterns from the Agent Permissions settings panel
 */
export async function getAllowedToolPatterns(page: Page): Promise<string[]> {
  const toolPatterns = page.locator(PLAYWRIGHT_TEST_SELECTORS.permissionsPatternName);
  const count = await toolPatterns.count();

  const patterns: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await toolPatterns.nth(i).textContent();
    if (text) {
      patterns.push(text.trim());
    }
  }

  return patterns;
}

// ============================================================================
// Walkthrough Guide System Helpers
// ============================================================================

/**
 * Wait for walkthrough helpers to be available on window
 */
export async function waitForWalkthroughHelpers(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__walkthroughHelpers != null, {
    timeout: 5000,
  });
}

/**
 * Reset walkthrough state to allow fresh testing
 */
export async function resetWalkthroughState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if ((window as any).__walkthroughHelpers) {
      await (window as any).__walkthroughHelpers.resetState();
    }
  });
  await page.waitForTimeout(300);
}

/**
 * Start a specific walkthrough by ID
 */
export async function startWalkthrough(page: Page, walkthroughId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as any).__walkthroughHelpers.startWalkthrough(id);
  }, walkthroughId);
}

/**
 * Get list of available walkthrough IDs
 */
export async function getAvailableWalkthroughs(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    return (window as any).__walkthroughHelpers?.listWalkthroughs() ?? [];
  });
}

/**
 * Get current walkthrough state (completed, dismissed, enabled, etc.)
 */
export async function getWalkthroughState(page: Page): Promise<{
  active: string | null;
  step: number;
  state: { enabled: boolean; completed: string[]; dismissed: string[] };
}> {
  return await page.evaluate(() => {
    return (window as any).__walkthroughHelpers.getState();
  });
}

/**
 * Wait for walkthrough callout to appear and verify it's visible
 */
export async function waitForWalkthroughCallout(
  page: Page,
  options: { timeout?: number } = {}
): Promise<void> {
  const { timeout = 5000 } = options;
  const callout = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCallout);
  await expect(callout).toBeVisible({ timeout });
}

/**
 * Click the Next button in the walkthrough callout
 */
export async function clickWalkthroughNext(page: Page): Promise<void> {
  const nextButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCalloutNextButton);
  await nextButton.click();
  await page.waitForTimeout(300);
}

/**
 * Click the Back button in the walkthrough callout
 */
export async function clickWalkthroughBack(page: Page): Promise<void> {
  const backButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCalloutBackButton);
  await backButton.click();
  await page.waitForTimeout(300);
}

/**
 * Dismiss walkthrough using the X button
 */
export async function dismissWalkthroughWithButton(page: Page): Promise<void> {
  const dismissButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCalloutDismiss);
  await dismissButton.click();
  await page.waitForTimeout(300);
}

/**
 * Dismiss walkthrough using Escape key
 */
export async function dismissWalkthroughWithEscape(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/**
 * Complete a multi-step walkthrough by clicking Next through all steps
 */
export async function completeWalkthrough(page: Page, stepCount: number): Promise<void> {
  const nextButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCalloutNextButton);

  for (let i = 0; i < stepCount; i++) {
    await nextButton.click();
    await page.waitForTimeout(300);
  }
}

/**
 * Verify walkthrough callout is not visible
 */
export async function verifyWalkthroughDismissed(page: Page): Promise<void> {
  const callout = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCallout);
  await expect(callout).not.toBeVisible();
}

/**
 * Verify walkthrough is marked as completed in state
 */
export async function verifyWalkthroughCompleted(
  page: Page,
  walkthroughId: string
): Promise<void> {
  const state = await getWalkthroughState(page);
  expect(state.state.completed).toContain(walkthroughId);
}

/**
 * Get walkthrough callout title text
 */
export async function getWalkthroughTitle(page: Page): Promise<string> {
  const title = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCalloutTitle);
  return await title.textContent() ?? '';
}

/**
 * Get walkthrough callout progress text (e.g., "1 of 2")
 */
export async function getWalkthroughProgress(page: Page): Promise<string> {
  const progress = page.locator(PLAYWRIGHT_TEST_SELECTORS.walkthroughCalloutProgress);
  return await progress.textContent() ?? '';
}
