/**
 * Consolidated permission tests (no real AI required).
 *
 * From:
 * - trust-and-persistence.spec.ts (trust toast workflow, tool/URL pattern persistence)
 * - bash-permissions.spec.ts (Bash command pattern matching, Allow Always)
 * - webfetch-url-persistence.spec.ts (URL pattern persistence, isUrlAllowed, wildcards)
 *
 * All tests share a single Electron app instance with beforeAll/afterAll.
 * Launched with permissionMode: 'none' so trust toast appears for trust workflow tests.
 * After trust workflow tests, workspace is trusted via IPC for remaining tests.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
} from '../utils/testHelpers';
import {
  getWorkspacePermissions,
  trustWorkspace,
  setPermissionMode,
  addAllowedPattern,
  addAllowedUrlPattern,
  isUrlAllowed,
  evaluateCommand,
  applyPermissionResponse,
  resetPermissions,
} from '../utils/permissionTestHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.setTimeout(60000);

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create test files
  await fs.writeFile(
    path.join(workspaceDir, 'test.md'),
    '# Test Document\n\nTest content.\n',
    'utf8'
  );

  // Launch with 'none' so trust toast appears for trust workflow tests
  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'none' });
  page = await electronApp.firstWindow();

  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);

  // Wait for workspace sidebar to be ready
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar))
    .toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================================
// Trust Workflow Tests (from trust-and-persistence.spec.ts)
// These run first because they need the trust toast to appear
// ============================================================================

test.describe('Trust Workflow', () => {
  test('trust workflow: trust via toast -> verify trusted state -> verify settings', async () => {
    // 1. Trust toast should appear for new workspace
    const trustToast = page.getByRole('heading', { name: /^Trust .+\?$/ });
    await expect(trustToast).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

    // 2. Verify permission options are available
    const allowEditsOption = page.getByRole('button', { name: /Allow Edits/ });
    await expect(allowEditsOption).toBeVisible();

    // 3. Click Allow Edits to trust the workspace
    await allowEditsOption.click();
    await page.waitForTimeout(300);

    // 4. Click Save to confirm
    const saveButton = page.getByRole('button', { name: 'Save' });
    await saveButton.click();
    await page.waitForTimeout(500);

    // 5. Toast should dismiss after selection
    await expect(trustToast).not.toBeVisible({ timeout: 3000 });

    // 6. Trust indicator should now show trusted state
    const trustIndicator = page.getByRole('button', { name: /Allow Edits mode|trusted/i }).first();
    await expect(trustIndicator).toBeVisible({ timeout: 3000 });
  });

  test('dismiss toast: click Cancel dismisses without trusting', async () => {
    // Revoke trust first so the toast appears again
    await page.evaluate(async (wsDir) => {
      await window.electronAPI.invoke('permissions:revokeWorkspaceTrust', wsDir);
    }, workspaceDir);
    await page.waitForTimeout(500);

    // 1. Trust toast should appear for now-untrusted workspace
    const trustToast = page.getByRole('heading', { name: /^Trust .+\?$/ });
    await expect(trustToast).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

    // 2. Click "Cancel" button to dismiss without trusting
    const cancelButton = page.getByRole('button', { name: 'Cancel' });
    await cancelButton.click();
    await page.waitForTimeout(500);

    // 3. Toast should dismiss
    await expect(trustToast).not.toBeVisible({ timeout: 3000 });

    // 4. Trust indicator should still show UNtrusted state
    const trustIndicator = page.getByRole('button', { name: /not trusted|untrusted/i }).first();
    await expect(trustIndicator).toBeVisible();
  });
});

// ============================================================================
// Permission Persistence Tests (from trust-and-persistence.spec.ts)
// These tests trust the workspace via IPC before running.
// ============================================================================

test.describe('Permission Persistence', () => {
  test('Tool pattern: adding pattern via IPC persists correctly', async () => {
    // Trust the workspace and set to "ask" mode via IPC
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');

    // Verify initial state - no patterns saved
    let permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.isTrusted).toBe(true);
    expect(permissions.permissionMode).toBe('ask');
    expect(permissions.allowedPatterns).toHaveLength(0);

    // Add a tool pattern (simulates "Allow Always" for WebSearch)
    await addAllowedPattern(page, workspaceDir, 'websearch', 'Search the web');

    // Verify pattern was saved
    permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.allowedPatterns.some(p => p.pattern === 'websearch')).toBe(true);
    expect(permissions.allowedPatterns.some(p => p.displayName === 'Search the web')).toBe(true);
  });

  test('URL pattern: adding hostname pattern via IPC persists correctly', async () => {
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');

    // Add a URL pattern (simulates "Allow Always" for WebFetch)
    await addAllowedUrlPattern(page, workspaceDir, 'example.com', 'Allow fetching from example.com');

    // Verify URL pattern was saved
    const permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.allowedUrlPatterns.some(p => p.pattern === 'example.com')).toBe(true);
    expect(permissions.allowedUrlPatterns.some(p => p.description === 'Allow fetching from example.com')).toBe(true);
  });

  test('Permission mode: changing mode persists correctly', async () => {
    await trustWorkspace(page, workspaceDir);

    // Set to 'ask' mode
    await setPermissionMode(page, workspaceDir, 'ask');
    let permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.permissionMode).toBe('ask');

    // Change to 'allow-all' mode
    await setPermissionMode(page, workspaceDir, 'allow-all');
    permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.permissionMode).toBe('allow-all');

    // Change back to 'ask' mode
    await setPermissionMode(page, workspaceDir, 'ask');
    permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.permissionMode).toBe('ask');
  });

  test('Multiple patterns: can add multiple tool and URL patterns', async () => {
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');

    // Add multiple tool patterns
    await addAllowedPattern(page, workspaceDir, 'edit', 'Edit files in project');
    await addAllowedPattern(page, workspaceDir, 'bash:npm test', 'Run npm test');

    // Add multiple URL patterns
    await addAllowedUrlPattern(page, workspaceDir, 'github.com', 'Allow github.com');

    // Verify all patterns were saved (includes patterns from previous tests)
    const permissions = await getWorkspacePermissions(page, workspaceDir);

    // Verify tool patterns exist
    expect(permissions.allowedPatterns.some(p => p.pattern === 'websearch')).toBe(true);
    expect(permissions.allowedPatterns.some(p => p.pattern === 'edit')).toBe(true);
    expect(permissions.allowedPatterns.some(p => p.pattern === 'bash:npm test')).toBe(true);

    // Verify URL patterns exist
    expect(permissions.allowedUrlPatterns.some(p => p.pattern === 'example.com')).toBe(true);
    expect(permissions.allowedUrlPatterns.some(p => p.pattern === 'github.com')).toBe(true);
  });
});

// ============================================================================
// Bash Pattern Generation (from bash-permissions.spec.ts)
// Read-only tests - no state mutation
// ============================================================================

test.describe('Bash pattern generation', () => {
  // Reset permissions before bash tests to start clean
  test('setup: reset permissions for bash tests', async () => {
    await resetPermissions(page, workspaceDir);
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');
  });

  test('npm commands generate correct patterns', async () => {
    const sessionId = 'test-session-npm';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm test');
    expect(result.decision).toBe('ask');
    expect(result.request).toBeDefined();
    expect(result.request!.actionsNeedingApproval).toHaveLength(1);

    const action = result.request!.actionsNeedingApproval[0];
    expect(action.action.pattern).toBe('npm:test');
    expect(action.action.displayName).toContain('npm test');
  });

  test('git push generates correct pattern (requires approval)', async () => {
    const sessionId = 'test-session-git';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'git push origin main');
    expect(result.decision).toBe('ask');
    expect(result.request).toBeDefined();

    const action = result.request!.actionsNeedingApproval[0];
    expect(action.action.pattern).toBe('git:push');
  });

  test('read-only git commands are auto-allowed', async () => {
    const sessionId = 'test-session-git-readonly';

    const statusResult = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'git status');
    expect(statusResult.decision).toBe('allow');

    const logResult = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'git log --oneline');
    expect(logResult.decision).toBe('allow');

    const diffResult = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'git diff HEAD');
    expect(diffResult.decision).toBe('allow');
  });

  test('rm -rf generates destructive pattern', async () => {
    const sessionId = 'test-session-rm';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'rm -rf node_modules');
    expect(result.decision).toBe('ask');
    expect(result.request).toBeDefined();
    expect(result.request!.hasDestructiveActions).toBe(true);

    const action = result.request!.actionsNeedingApproval[0];
    expect(action.action.pattern).toBe('bash:rm-rf');
    expect(action.action.displayName).toContain('Recursive delete');
  });

  test('read-only bash commands like ls and cat are auto-allowed', async () => {
    const sessionId = 'test-session-readonly';

    const lsResult = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'ls -la');
    expect(lsResult.decision).toBe('allow');

    const catResult = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'cat file.txt');
    expect(catResult.decision).toBe('allow');
  });
});

// ============================================================================
// Pattern Display Names (from bash-permissions.spec.ts)
// ============================================================================

test.describe('Pattern display names', () => {
  test('npm commands show user-friendly display names', async () => {
    const sessionId = 'test-session-display';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm run build');
    const action = result.request!.actionsNeedingApproval[0];

    expect(action.action.displayName).toContain('npm');
    expect(action.action.displayName).toContain('build');
  });

  test('destructive commands show warning in display name', async () => {
    const sessionId = 'test-session-destructive';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'rm -rf /tmp/test');
    const action = result.request!.actionsNeedingApproval[0];

    expect(action.action.displayName.toLowerCase()).toContain('destructive');
  });
});

// ============================================================================
// Compound Commands (from bash-permissions.spec.ts)
// ============================================================================

test.describe('Compound commands', () => {
  test('compound commands with && generate multiple patterns', async () => {
    const sessionId = 'test-session-compound';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm install && npm test');
    expect(result.decision).toBe('ask');
    expect(result.request).toBeDefined();

    expect(result.request!.actionsNeedingApproval.length).toBeGreaterThanOrEqual(1);

    const patterns = result.request!.actionsNeedingApproval.map(a => a.action.pattern);
    expect(patterns.some(p => p.includes('npm'))).toBe(true);
  });
});

// ============================================================================
// Allow Always Persistence (from bash-permissions.spec.ts)
// Mutates workspace patterns
// ============================================================================

test.describe('Allow Always persistence', () => {
  test('setup: reset permissions for Allow Always tests', async () => {
    await resetPermissions(page, workspaceDir);
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');
  });

  test('allowing npm:test pattern auto-approves subsequent npm test commands', async () => {
    const sessionId = 'test-session-npm-always';

    const result1 = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm test');
    expect(result1.decision).toBe('ask');
    expect(result1.request).toBeDefined();

    await applyPermissionResponse(page, workspaceDir, sessionId, result1.request!.id, {
      decision: 'allow',
      scope: 'always',
    });

    const permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.allowedPatterns.some(p => p.pattern === 'npm:test')).toBe(true);

    const result2 = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm test');
    expect(result2.decision).toBe('allow');
  });

  test('allowing npm:test does NOT auto-approve npm install', async () => {
    const sessionId = 'test-session-npm-different';

    const testResult = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm test');
    if (testResult.decision === 'ask') {
      await applyPermissionResponse(page, workspaceDir, sessionId, testResult.request!.id, {
        decision: 'allow',
        scope: 'always',
      });
    }

    const installResult = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm install');
    expect(installResult.decision).toBe('ask');
    expect(installResult.request!.actionsNeedingApproval[0].action.pattern).toBe('npm:install');
  });

  test('allowing git:push auto-approves regular pushes but not force pushes', async () => {
    const sessionId = 'test-session-git-push';

    const result1 = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'git push origin main');
    expect(result1.decision).toBe('ask');
    await applyPermissionResponse(page, workspaceDir, sessionId, result1.request!.id, {
      decision: 'allow',
      scope: 'always',
    });

    const permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.allowedPatterns.some(p => p.pattern === 'git:push')).toBe(true);

    const result2 = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'git push origin feature-branch');
    expect(result2.decision).toBe('allow');

    const result3 = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'git push --force');
    expect(result3.decision).toBe('ask');
    expect(result3.request!.actionsNeedingApproval[0].action.pattern).toBe('git:push-force');
    expect(result3.request!.hasDestructiveActions).toBe(true);
  });
});

// ============================================================================
// Session vs Always Scope (from bash-permissions.spec.ts)
// ============================================================================

test.describe('Session vs Always scope', () => {
  test('Allow Session saves pattern only for the session', async () => {
    const sessionId = 'test-session-scope';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm test');
    if (result.decision === 'ask') {
      await applyPermissionResponse(page, workspaceDir, sessionId, result.request!.id, {
        decision: 'allow',
        scope: 'session',
      });
    }

    const uniqueResult = await evaluateCommand(page, workspaceDir, 'test-session-scope-2', 'Bash', 'npm run lint');
    if (uniqueResult.decision === 'ask') {
      await applyPermissionResponse(page, workspaceDir, 'test-session-scope-2', uniqueResult.request!.id, {
        decision: 'allow',
        scope: 'session',
      });
      const permissions = await getWorkspacePermissions(page, workspaceDir);
      expect(permissions.allowedPatterns.some(p => p.pattern === 'npm:lint')).toBe(false);
    }
  });

  test('Allow Once does not save any pattern', async () => {
    const sessionId = 'test-session-once';

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm run format');
    if (result.decision === 'ask') {
      await applyPermissionResponse(page, workspaceDir, sessionId, result.request!.id, {
        decision: 'allow',
        scope: 'once',
      });

      const permissions = await getWorkspacePermissions(page, workspaceDir);
      expect(permissions.allowedPatterns.some(p => p.pattern === 'npm:format')).toBe(false);
    }
  });
});

// ============================================================================
// Direct Pattern Addition (from bash-permissions.spec.ts)
// ============================================================================

test.describe('Direct pattern addition', () => {
  test('manually adding bash pattern auto-approves matching commands', async () => {
    const sessionId = 'test-session-direct';

    await addAllowedPattern(page, workspaceDir, 'npm:start', 'npm start');

    const permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.allowedPatterns.some(p => p.pattern === 'npm:start')).toBe(true);

    const result = await evaluateCommand(page, workspaceDir, sessionId, 'Bash', 'npm start');
    expect(result.decision).toBe('allow');
  });
});

// ============================================================================
// WebFetch URL Pattern Persistence (from webfetch-url-persistence.spec.ts)
// ============================================================================

test.describe('WebFetch URL pattern persistence', () => {
  test('setup: reset permissions for URL pattern tests', async () => {
    await resetPermissions(page, workspaceDir);
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');
  });

  test('isUrlAllowed returns true immediately after adding pattern', async () => {
    const initialCheck = await isUrlAllowed(page, workspaceDir, 'https://example.com/some/path');
    expect(initialCheck).toBe(false);

    await addAllowedUrlPattern(page, workspaceDir, 'example.com', 'Allow fetching from example.com');

    const afterAddCheck = await isUrlAllowed(page, workspaceDir, 'https://example.com/some/path');
    expect(afterAddCheck).toBe(true);

    const differentPathCheck = await isUrlAllowed(page, workspaceDir, 'https://example.com/another/path');
    expect(differentPathCheck).toBe(true);

    const differentDomainCheck = await isUrlAllowed(page, workspaceDir, 'https://other.com/path');
    expect(differentDomainCheck).toBe(false);
  });

  test('isUrlAllowed works for multiple patterns', async () => {
    await addAllowedUrlPattern(page, workspaceDir, 'example.com', 'Allow example.com');
    await addAllowedUrlPattern(page, workspaceDir, 'github.com', 'Allow github.com');
    await addAllowedUrlPattern(page, workspaceDir, 'docs.anthropic.com', 'Allow docs.anthropic.com');

    expect(await isUrlAllowed(page, workspaceDir, 'https://example.com/foo')).toBe(true);
    expect(await isUrlAllowed(page, workspaceDir, 'https://github.com/user/repo')).toBe(true);
    expect(await isUrlAllowed(page, workspaceDir, 'https://docs.anthropic.com/api')).toBe(true);

    expect(await isUrlAllowed(page, workspaceDir, 'https://malicious.com/hack')).toBe(false);
  });

  test('pattern saved to disk and retrieved correctly', async () => {
    await addAllowedUrlPattern(page, workspaceDir, 'docs.anthropic.com', 'Anthropic docs');

    const permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.allowedUrlPatterns.some(p => p.pattern === 'docs.anthropic.com')).toBe(true);

    expect(await isUrlAllowed(page, workspaceDir, 'https://docs.anthropic.com/claude/api')).toBe(true);
  });

  test('persists across app restart', async () => {
    await resetPermissions(page, workspaceDir);
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');
    await addAllowedUrlPattern(page, workspaceDir, 'example.com', 'Allow example.com');

    expect(await isUrlAllowed(page, workspaceDir, 'https://example.com/test')).toBe(true);

    // Close and relaunch
    await electronApp.evaluate(async ({ app }) => {
      app.exit(0);
    });
    await new Promise(resolve => setTimeout(resolve, 1000));

    electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'none' });
    page = await electronApp.firstWindow();
    await waitForAppReady(page);
    await dismissProjectTrustToast(page);
    await dismissAPIKeyDialog(page);

    const afterRestartCheck = await isUrlAllowed(page, workspaceDir, 'https://example.com/test');
    expect(afterRestartCheck).toBe(true);

    const permissions = await getWorkspacePermissions(page, workspaceDir);
    expect(permissions.allowedUrlPatterns.some(p => p.pattern === 'example.com')).toBe(true);
  });

  test('multiple checks use same cached engine', async () => {
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');
    await addAllowedUrlPattern(page, workspaceDir, 'example.com', 'Allow example.com');

    const results: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await isUrlAllowed(page, workspaceDir, `https://example.com/path${i}`);
      results.push(result);
    }
    expect(results.every(r => r === true)).toBe(true);
  });

  test('wildcard pattern allows all URLs', async () => {
    await resetPermissions(page, workspaceDir);
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');

    expect(await isUrlAllowed(page, workspaceDir, 'https://example.com/test')).toBe(false);
    expect(await isUrlAllowed(page, workspaceDir, 'https://random-site.com/page')).toBe(false);

    await addAllowedUrlPattern(page, workspaceDir, '*', 'Allow all web fetches');

    expect(await isUrlAllowed(page, workspaceDir, 'https://example.com/test')).toBe(true);
    expect(await isUrlAllowed(page, workspaceDir, 'https://random-site.com/page')).toBe(true);
    expect(await isUrlAllowed(page, workspaceDir, 'https://any.domain.com/any/path')).toBe(true);
  });

  test('subdomain handling', async () => {
    await resetPermissions(page, workspaceDir);
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'ask');

    await addAllowedUrlPattern(page, workspaceDir, 'docs.anthropic.com', 'Allow docs subdomain');

    expect(await isUrlAllowed(page, workspaceDir, 'https://docs.anthropic.com/api')).toBe(true);
    expect(await isUrlAllowed(page, workspaceDir, 'https://anthropic.com/home')).toBe(false);
    expect(await isUrlAllowed(page, workspaceDir, 'https://api.anthropic.com/v1')).toBe(false);
  });

  test('allow-all mode bypasses URL pattern checks', async () => {
    await trustWorkspace(page, workspaceDir);
    await setPermissionMode(page, workspaceDir, 'allow-all');

    expect(await isUrlAllowed(page, workspaceDir, 'https://example.com/test')).toBe(true);
    expect(await isUrlAllowed(page, workspaceDir, 'https://any-site.com/path')).toBe(true);

    await setPermissionMode(page, workspaceDir, 'ask');

    expect(await isUrlAllowed(page, workspaceDir, 'https://example.com/test')).toBe(false);
  });
});
