/**
 * IPC handlers for slash command discovery and management
 */

import { getAgentWorkflowService, type AgentWorkflowEntry } from '../services/AgentWorkflowService';
import { safeHandle } from '../utils/ipcRegistry';
import { syncProjectCommandsToMobile } from '../services/SyncManager';

/**
 * Register all slash command IPC handlers
 */
export function registerSlashCommandHandlers() {
  safeHandle('slash-command:list', async (_event, payload: { workspacePath: string; provider?: string | null; sdkCommands?: string[]; sdkSkills?: string[] }) => {
    try {
      const {
        workspacePath,
        provider = 'claude-code',
        sdkCommands = [],
        sdkSkills = [],
      } = payload;

      if (!workspacePath) {
        console.warn('[SlashCommandHandlers] No workspace path provided');
        return [];
      }

      const service = getAgentWorkflowService(workspacePath);
      const commands = await service.listEntries({
        provider,
        nativeCommands: sdkCommands,
        nativeSkills: sdkSkills,
      });

      // console.log(`[SlashCommandHandlers] Returning ${deduplicatedCommands.length} slash commands (deduped from ${allCommands.length}) for workspace: ${workspacePath}`);

      // Fire-and-forget: sync commands to mobile via index room
      syncProjectCommandsToMobile(workspacePath, commands as AgentWorkflowEntry[]).catch(() => {
        // Silently ignore - sync is best-effort
      });

      return commands;
    } catch (error) {
      console.error('[SlashCommandHandlers] Error listing slash commands:', error);
      return [];
    }
  });

  // Get a specific command
  safeHandle('slash-command:get', async (_event, payload: { workspacePath: string; commandName: string; provider?: string | null; sdkCommands?: string[]; sdkSkills?: string[] }) => {
    try {
      const {
        workspacePath,
        commandName,
        provider = 'claude-code',
        sdkCommands = [],
        sdkSkills = [],
      } = payload;

      if (!workspacePath) {
        console.warn('[SlashCommandHandlers] No workspace path provided');
        return null;
      }

      const service = getAgentWorkflowService(workspacePath);
      const command = await service.getEntryByName(commandName, {
        provider,
        nativeCommands: sdkCommands,
        nativeSkills: sdkSkills,
      });

      return command;
    } catch (error) {
      console.error('[SlashCommandHandlers] Error getting slash command:', error);
      return null;
    }
  });

  // Clear cache for a workspace
  safeHandle('slash-command:clearCache', async (event, workspacePath: string) => {
    try {
      if (!workspacePath) {
        console.warn('[SlashCommandHandlers] No workspace path provided');
        return { success: false };
      }

      getAgentWorkflowService(workspacePath).clearCache();

      return { success: true };
    } catch (error) {
      console.error('[SlashCommandHandlers] Error clearing cache:', error);
      return { success: false };
    }
  });

  // console.log('[SlashCommandHandlers] Registered slash command IPC handlers');
}
