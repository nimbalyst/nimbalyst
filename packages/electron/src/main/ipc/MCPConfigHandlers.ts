import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { MCPConfigService, TestProgressCallback } from '../services/MCPConfigService';
import { MCPConfig, MCPServerConfig } from '@nimbalyst/runtime/types/MCPServerConfig';
import { logger } from '../utils/logger';
import {
  checkMcpRemoteAuthStatus,
  discoverMcpRemoteOAuthRequirement,
  extractMcpRemoteConfig,
  revokeMcpRemoteOAuth,
  triggerMcpRemoteOAuth,
} from '../services/MCPRemoteOAuth';
import { getToolBudgetSnapshot } from '../mcp/toolBudgetService';

const mcpConfigService = new MCPConfigService();

export function registerMCPConfigHandlers() {
  safeHandle('mcp-config:read-user', async () => {
    try {
      return await mcpConfigService.readUserMCPConfig();
    } catch (error) {
      logger.main.error('[MCP] Failed to read user config:', error);
      throw error;
    }
  });

  safeHandle('mcp-config:write-user', async (_event, config: MCPConfig) => {
    try {
      await mcpConfigService.writeUserMCPConfig(config);
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[MCP] Failed to write user config:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('mcp-config:read-workspace', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      return await mcpConfigService.readWorkspaceMCPConfig(workspacePath);
    } catch (error) {
      logger.main.error('[MCP] Failed to read workspace config:', error);
      throw error;
    }
  });

  safeHandle('mcp-config:write-workspace', async (_event, workspacePath: string, config: MCPConfig) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      await mcpConfigService.writeWorkspaceMCPConfig(workspacePath, config);
      return { success: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[MCP] Failed to write workspace config:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('mcp-config:get-merged', async (_event, workspacePath?: string) => {
    try {
      return await mcpConfigService.getMergedConfig(workspacePath);
    } catch (error) {
      logger.main.error('[MCP] Failed to get merged config:', error);
      throw error;
    }
  });

  safeHandle('mcp-config:validate', async (_event, config: MCPConfig) => {
    try {
      mcpConfigService.validateConfig(config);
      return { valid: true };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { valid: false, error: message };
    }
  });

  safeHandle('mcp-config:get-tool-budget', async (_event, workspacePath?: string) => {
    try {
      return await getToolBudgetSnapshot(workspacePath);
    } catch (error) {
      logger.main.error('[MCP] Failed to build tool budget snapshot:', error);
      throw error;
    }
  });

  safeHandle('mcp-config:get-user-path', () => mcpConfigService.getUserConfigPath());

  safeHandle('mcp-config:get-workspace-path', (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    return mcpConfigService.getWorkspaceConfigPath(workspacePath);
  });

  safeHandle('mcp-config:test-server', async (event, config: MCPServerConfig) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      const onProgress: TestProgressCallback = (status, message) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('mcp-config:test-progress', { status, message });
        }
      };
      return await mcpConfigService.testServerConnection(config, onProgress);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[MCP] Failed to test server:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('mcp-config:check-oauth-status', async (_event, serverConfigOrUrl: MCPServerConfig | string) => {
    try {
      if (typeof serverConfigOrUrl !== 'string') {
        const remoteConfig = extractMcpRemoteConfig(serverConfigOrUrl);
        const requiresOAuth = remoteConfig
          ? await discoverMcpRemoteOAuthRequirement(remoteConfig)
          : false;

        if (!requiresOAuth) {
          return { authorized: true, requiresOAuth };
        }

        const status = await checkMcpRemoteAuthStatus(serverConfigOrUrl);
        return { ...status, requiresOAuth };
      }

      return await checkMcpRemoteAuthStatus(serverConfigOrUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[MCP] Failed to check OAuth status:', error);
      return { authorized: false, error: message };
    }
  });

  safeHandle('mcp-config:trigger-oauth', async (_event, serverConfigOrUrl: MCPServerConfig | string) => {
    try {
      return await triggerMcpRemoteOAuth(serverConfigOrUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[MCP] Failed to trigger OAuth:', error);
      return { success: false, error: message };
    }
  });

  safeHandle('mcp-config:revoke-oauth', async (_event, serverConfigOrUrl: MCPServerConfig | string) => {
    try {
      return await revokeMcpRemoteOAuth(serverConfigOrUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[MCP] Failed to revoke OAuth:', error);
      return { success: false, error: message };
    }
  });
}
