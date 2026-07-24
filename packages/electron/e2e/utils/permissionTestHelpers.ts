/**
 * Test helpers for permission system testing without AI agent involvement.
 *
 * These helpers allow testing the permission flow by calling IPC handlers
 * from the renderer process (via page.evaluate) which then invoke the main
 * process permission service.
 */

import type { ElectronApplication, Page } from 'playwright';

/**
 * Permission state returned by the permission service
 */
export interface PermissionsState {
  isTrusted: boolean;
  trustedAt?: number;
  permissionMode: 'ask' | 'allow-all';
  allowedPatterns: Array<{ pattern: string; displayName: string; addedAt: number }>;
  deniedPatterns: Array<{ pattern: string; displayName: string; addedAt: number }>;
  additionalDirectories: Array<{ path: string; canWrite: boolean; addedAt: number }>;
  allowedUrlPatterns: Array<{ pattern: string; description: string; addedAt: number }>;
}

/**
 * Get workspace permissions via IPC (renderer -> main)
 */
export async function getWorkspacePermissions(
  page: Page,
  workspacePath: string
): Promise<PermissionsState> {
  return await page.evaluate(
    async (workspacePath) => {
      return await (window as any).electronAPI.invoke('permissions:getWorkspacePermissions', workspacePath);
    },
    workspacePath
  );
}

/**
 * Trust a workspace via IPC (renderer -> main)
 */
export async function trustWorkspace(
  page: Page,
  workspacePath: string
): Promise<void> {
  await page.evaluate(
    async (workspacePath) => {
      await (window as any).electronAPI.invoke('permissions:trustWorkspace', workspacePath);
    },
    workspacePath
  );
}

/**
 * Set permission mode for a workspace via IPC (renderer -> main)
 */
export async function setPermissionMode(
  page: Page,
  workspacePath: string,
  mode: 'ask' | 'allow-all'
): Promise<void> {
  await page.evaluate(
    async ({ workspacePath, mode }) => {
      await (window as any).electronAPI.invoke('permissions:setPermissionMode', workspacePath, mode);
    },
    { workspacePath, mode }
  );
}

/**
 * Add an allowed tool pattern directly via IPC (renderer -> main)
 */
export async function addAllowedPattern(
  page: Page,
  workspacePath: string,
  pattern: string,
  displayName: string
): Promise<void> {
  await page.evaluate(
    async ({ workspacePath, pattern, displayName }) => {
      await (window as any).electronAPI.invoke('permissions:addAllowedPattern', workspacePath, pattern, displayName);
    },
    { workspacePath, pattern, displayName }
  );
}

/**
 * Add an allowed URL pattern directly via IPC (renderer -> main)
 */
export async function addAllowedUrlPattern(
  page: Page,
  workspacePath: string,
  pattern: string,
  description: string
): Promise<void> {
  await page.evaluate(
    async ({ workspacePath, pattern, description }) => {
      await (window as any).electronAPI.invoke('permissions:addAllowedUrlPattern', workspacePath, pattern, description);
    },
    { workspacePath, pattern, description }
  );
}

/**
 * Check if a URL is allowed via IPC (renderer -> main)
 * This calls through the PermissionService to check against saved patterns
 */
export async function isUrlAllowed(
  page: Page,
  workspacePath: string,
  url: string
): Promise<boolean> {
  return await page.evaluate(
    async ({ workspacePath, url }) => {
      return await (window as any).electronAPI.invoke('permissions:isUrlAllowed', workspacePath, url);
    },
    { workspacePath, url }
  );
}

/**
 * Create a mock permission request for testing
 */
export function createMockPermissionRequest(
  toolName: string,
  pattern: string,
  displayName: string,
  rawCommand: string
) {
  const requestId = `test-perm-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return {
    id: requestId,
    toolName,
    rawCommand,
    actionsNeedingApproval: [{
      action: { pattern, displayName },
      decision: 'ask' as const,
      reason: 'Test permission request',
      warnings: [] as string[],
      outsidePaths: [] as string[],
      sensitivePaths: [] as string[],
    }],
    hasDestructiveActions: false,
    createdAt: Date.now(),
  };
}

/**
 * Reset workspace permissions to defaults via IPC (renderer -> main)
 */
export async function resetPermissions(
  page: Page,
  workspacePath: string
): Promise<void> {
  await page.evaluate(
    async (workspacePath) => {
      await (window as any).electronAPI.invoke('permissions:resetToDefaults', workspacePath);
    },
    workspacePath
  );
}

/**
 * Evaluation result from the permission service
 */
export interface EvaluationResult {
  decision: 'allow' | 'deny' | 'ask';
  request?: {
    id: string;
    toolName: string;
    rawCommand: string;
    actionsNeedingApproval: Array<{
      action: { pattern: string; displayName: string };
      decision: 'ask' | 'allow' | 'deny';
      reason: string;
      warnings: string[];
      outsidePaths: string[];
      sensitivePaths: string[];
    }>;
    hasDestructiveActions: boolean;
    createdAt: number;
  };
}

/**
 * Evaluate a tool command and get the permission decision via IPC (renderer -> main)
 */
export async function evaluateCommand(
  page: Page,
  workspacePath: string,
  sessionId: string,
  toolName: string,
  toolDescription: string
): Promise<EvaluationResult> {
  return await page.evaluate(
    async ({ workspacePath, sessionId, toolName, toolDescription }) => {
      return await (window as any).electronAPI.invoke(
        'permissions:evaluateCommand',
        workspacePath,
        sessionId,
        toolName,
        toolDescription
      );
    },
    { workspacePath, sessionId, toolName, toolDescription }
  );
}

/**
 * Apply a permission response (simulates user clicking Allow/Deny) via IPC (renderer -> main)
 */
export async function applyPermissionResponse(
  page: Page,
  workspacePath: string,
  sessionId: string,
  requestId: string,
  response: { decision: 'allow' | 'deny'; scope: 'once' | 'session' | 'always' }
): Promise<void> {
  await page.evaluate(
    async ({ workspacePath, sessionId, requestId, response }) => {
      await (window as any).electronAPI.invoke(
        'permissions:applyResponse',
        workspacePath,
        sessionId,
        requestId,
        response
      );
    },
    { workspacePath, sessionId, requestId, response }
  );
}
