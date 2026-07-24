/**
 * IPC handlers for agent permission settings
 *
 * WORKTREE SUPPORT: All handlers that deal with workspace permissions resolve
 * worktree paths to their parent project. This ensures worktrees inherit and
 * share permissions with their parent project.
 */
import * as path from 'path';
import { dialog, BrowserWindow } from 'electron';
import { getPermissionService, resolveWorkspacePathForPermissions } from '../services/PermissionService';
import { ClaudeSettingsManager } from '../services/ClaudeSettingsManager';
import { logger } from '../utils/logger';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { resolveProjectPath, isWorktreePath } from '../utils/workspaceDetection';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';

/**
 * Broadcast permission changes to all renderer processes.
 * If the path is a worktree, broadcasts to both the worktree path and the parent project path.
 */
function broadcastPermissionChange(workspacePath: string): void {
  const windows = BrowserWindow.getAllWindows();
  const projectPath = resolveProjectPath(workspacePath);

  for (const window of windows) {
    // Always broadcast for the original path
    window.webContents.send('permissions:changed', { workspacePath });

    // If this was a worktree, also broadcast for the parent project
    // so windows viewing the main project are notified too
    if (isWorktreePath(workspacePath)) {
      window.webContents.send('permissions:changed', { workspacePath: projectPath });
    }
  }
}

export function registerPermissionHandlers(): void {
  const permissionService = getPermissionService();

  // Open directory dialog for selecting additional directories
  safeHandle('dialog:openDirectory', async (event, options?: { title?: string; buttonLabel?: string }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: options?.title || 'Select Directory',
      buttonLabel: options?.buttonLabel || 'Select',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getDialogDefaultPath({ window }),
    };
    const result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (!result.canceled) {
      rememberDialogSelection(result.filePaths[0], 'directory');
    }
    return result;
  });

  // Get workspace permissions (trust status, allowed/denied patterns, mode, directories)
  // Now reads from Claude settings files (.claude/settings.local.json) for patterns
  // NOTE: Resolves worktree paths to parent project
  safeHandle('permissions:getWorkspacePermissions', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    const workspaceName = path.basename(workspacePath) || workspacePath;

    try {
      // Resolve worktree paths to parent project for permission lookups
      const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();

      // Get trust mode from our store (still managed by us)
      const permissionMode = permissionService.getPermissionMode(resolvedPath);
      const isTrusted = permissionMode !== null;
      logger.main.info(`[PermissionHandlers:${workspaceName}] getWorkspacePermissions - permissionMode:`, { permissionMode, isTrusted });

      // Read patterns from Claude settings files
      const effectiveSettings = await claudeSettingsManager.getEffectiveSettings(workspacePath);
      const claudePermissions = effectiveSettings.permissions;

      // Convert Claude patterns to our display format
      const allowedPatterns = claudePermissions.allow.map((pattern, index) => ({
        pattern,
        displayName: pattern, // Claude patterns are self-descriptive
        addedAt: Date.now() - index, // No timestamp in Claude settings, use index for ordering
      }));

      // Additional directories from Claude settings
      const additionalDirectories = (claudePermissions.additionalDirectories || []).map((dir, index) => ({
        path: dir,
        addedAt: Date.now() - index,
      }));

      // Extract URL patterns from allowed patterns (those that start with WebFetch)
      const allowedUrlPatterns = claudePermissions.allow
        .filter(p => p.startsWith('WebFetch'))
        .map((pattern, index) => {
          // Parse WebFetch(domain:example.com) format
          const match = pattern.match(/^WebFetch\(domain:(.+)\)$/);
          const domain = match ? match[1] : pattern;
          return {
            pattern: domain,
            description: `Allow fetching from ${domain}`,
            addedAt: Date.now() - index,
          };
        });

      // logger.main.info(`[PermissionHandlers:${workspaceName}] getWorkspacePermissions:`, {
      //   workspace: workspacePath,
      //   isTrusted,
      //   permissionMode,
      //   allowedPatternsCount: allowedPatterns.length,
      //   additionalDirectoriesCount: additionalDirectories.length,
      //   allowedUrlPatternsCount: allowedUrlPatterns.length,
      //   sources: effectiveSettings.sources,
      // });

      return {
        isTrusted,
        allowedPatterns,
        permissionMode, // null means not trusted, don't default
        additionalDirectories,
        allowedUrlPatterns,
        allowAllUsesClassifier: permissionService.getAllowAllUsesClassifier(resolvedPath),
      };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to get workspace permissions:', error);
      throw error;
    }
  });

  // Trust a workspace for agent operations
  // NOTE: Resolves worktree paths to parent project
  safeHandle('permissions:trustWorkspace', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      // Resolve worktree paths to parent project
      const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
      permissionService.trustWorkspace(resolvedPath);
      logger.main.info('[PermissionHandlers] Workspace trusted:', resolvedPath);

      // Broadcast using resolved path (parent project for worktrees)
      // This notifies all windows, which will fetch permissions for their own workspace
      broadcastPermissionChange(resolvedPath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to trust workspace:', error);
      throw error;
    }
  });

  // Revoke workspace trust
  // NOTE: Resolves worktree paths to parent project
  safeHandle('permissions:revokeWorkspaceTrust', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      // Resolve worktree paths to parent project
      const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
      permissionService.revokeWorkspaceTrust(resolvedPath);
      logger.main.info('[PermissionHandlers] Workspace trust revoked:', resolvedPath);

      // Broadcast using resolved path (parent project for worktrees)
      broadcastPermissionChange(resolvedPath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to revoke workspace trust:', error);
      throw error;
    }
  });

  // Remove a pattern rule (from Claude settings)
  safeHandle('permissions:removePattern', async (_event, workspacePath: string, pattern: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!pattern) {
      throw new Error('pattern is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      await claudeSettingsManager.removeAllowedTool(workspacePath, pattern);
      logger.main.info('[PermissionHandlers] Pattern removed from Claude settings:', pattern);
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to remove pattern:', error);
      throw error;
    }
  });

  // Reset permissions to defaults - clears all patterns from Claude settings
  safeHandle('permissions:resetToDefaults', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      // Get current settings
      const settings = await claudeSettingsManager.getEffectiveSettings(workspacePath);
      // Remove all allowed patterns
      for (const pattern of settings.permissions.allow) {
        await claudeSettingsManager.removeAllowedTool(workspacePath, pattern);
      }
      // Remove all additional directories
      for (const dir of settings.permissions.additionalDirectories || []) {
        await claudeSettingsManager.removeAdditionalDirectory(workspacePath, dir);
      }
      logger.main.info('[PermissionHandlers] Permissions reset to defaults:', workspacePath);
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to reset permissions:', error);
      throw error;
    }
  });

  // Add an allowed pattern manually (to Claude settings)
  safeHandle('permissions:addAllowedPattern', async (_event, workspacePath: string, pattern: string, _displayName: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!pattern) {
      throw new Error('pattern is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      await claudeSettingsManager.addAllowedTool(workspacePath, pattern);
      logger.main.info('[PermissionHandlers] Allowed pattern added to Claude settings:', pattern);
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to add allowed pattern:', error);
      throw error;
    }
  });

  // Denied patterns are no longer persisted - deny is just a one-time action
  // This handler is kept for backward compatibility but does nothing
  safeHandle('permissions:addDeniedPattern', async (_event, _workspacePath: string, pattern: string, _displayName: string) => {
    logger.main.info('[PermissionHandlers] Denied pattern ignored (denials are not persisted):', pattern);
    return { success: true };
  });

  // Set permission mode
  // NOTE: Resolves worktree paths to parent project
  safeHandle('permissions:setPermissionMode', async (_event, workspacePath: string, mode: 'ask' | 'allow-all' | 'bypass-all') => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (mode !== 'ask' && mode !== 'allow-all' && mode !== 'bypass-all') {
      throw new Error('mode must be "ask", "allow-all", or "bypass-all"');
    }

    try {
      // Resolve worktree paths to parent project
      const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
      logger.main.info('[PermissionHandlers] Setting permission mode:', { workspacePath, resolvedPath, mode });
      permissionService.setPermissionMode(resolvedPath, mode);
      // Verify it was saved correctly
      const savedMode = permissionService.getPermissionMode(resolvedPath);
      logger.main.info('[PermissionHandlers] Permission mode after save:', { mode, savedMode, isTrusted: savedMode !== null });

      // Broadcast using resolved path (parent project for worktrees)
      broadcastPermissionChange(resolvedPath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to set permission mode:', error);
      throw error;
    }
  });

  // Toggle the "Allow All" automatic-review opt-in (issue #628)
  // NOTE: Resolves worktree paths to parent project
  safeHandle('permissions:setAllowAllUsesClassifier', async (_event, workspacePath: string, enabled: boolean) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }

    try {
      const resolvedPath = await resolveWorkspacePathForPermissions(workspacePath);
      permissionService.setAllowAllUsesClassifier(resolvedPath, enabled);
      logger.main.info('[PermissionHandlers] Set allowAllUsesClassifier:', { resolvedPath, enabled });
      broadcastPermissionChange(resolvedPath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to set allowAllUsesClassifier:', error);
      throw error;
    }
  });

  // Add an additional directory (to Claude settings)
  safeHandle('permissions:addAdditionalDirectory', async (_event, workspacePath: string, dirPath: string, _canWrite: boolean) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!dirPath) {
      throw new Error('dirPath is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      await claudeSettingsManager.addAdditionalDirectory(workspacePath, dirPath);
      logger.main.info('[PermissionHandlers] Additional directory added to Claude settings:', dirPath);
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to add additional directory:', error);
      throw error;
    }
  });

  // Remove an additional directory (from Claude settings)
  safeHandle('permissions:removeAdditionalDirectory', async (_event, workspacePath: string, dirPath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!dirPath) {
      throw new Error('dirPath is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      await claudeSettingsManager.removeAdditionalDirectory(workspacePath, dirPath);
      logger.main.info('[PermissionHandlers] Additional directory removed from Claude settings:', dirPath);
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to remove additional directory:', error);
      throw error;
    }
  });

  // Update an additional directory's write access
  // Note: Claude settings don't distinguish read/write for additional directories
  // All additional directories have full access. This handler is kept for backward compatibility.
  safeHandle('permissions:updateAdditionalDirectoryAccess', async (_event, workspacePath: string, dirPath: string, canWrite: boolean) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!dirPath) {
      throw new Error('dirPath is required');
    }

    // Claude settings don't support read-only directories - log and return success
    logger.main.info('[PermissionHandlers] Additional directory access update ignored (Claude settings use full access):', dirPath, 'requested canWrite:', canWrite);
    return { success: true };
  });

  // Get allowed URL patterns (from Claude settings)
  safeHandle('permissions:getAllowedUrlPatterns', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      const settings = await claudeSettingsManager.getEffectiveSettings(workspacePath);
      // Extract WebFetch patterns and convert to URL patterns
      return settings.permissions.allow
        .filter(p => p.startsWith('WebFetch'))
        .map((pattern, index) => {
          if (pattern === 'WebFetch') {
            return { pattern: '*', description: 'All URLs allowed', addedAt: Date.now() - index };
          }
          const match = pattern.match(/^WebFetch\(domain:(.+)\)$/);
          const domain = match ? match[1] : pattern;
          return { pattern: domain, description: `Allow fetching from ${domain}`, addedAt: Date.now() - index };
        });
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to get allowed URL patterns:', error);
      throw error;
    }
  });

  // Add an allowed URL pattern (to Claude settings as WebFetch pattern)
  safeHandle('permissions:addAllowedUrlPattern', async (_event, workspacePath: string, pattern: string, _description: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!pattern) {
      throw new Error('pattern is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      // Convert to Claude format: domain -> WebFetch(domain:domain)
      const claudePattern = pattern === '*' ? 'WebFetch' : `WebFetch(domain:${pattern})`;
      await claudeSettingsManager.addAllowedTool(workspacePath, claudePattern);
      logger.main.info('[PermissionHandlers] Allowed URL pattern added to Claude settings:', claudePattern);
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to add allowed URL pattern:', error);
      throw error;
    }
  });

  // Remove an allowed URL pattern (from Claude settings)
  safeHandle('permissions:removeAllowedUrlPattern', async (_event, workspacePath: string, pattern: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!pattern) {
      throw new Error('pattern is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      // Convert to Claude format for removal
      const claudePattern = pattern === '*' ? 'WebFetch' : `WebFetch(domain:${pattern})`;
      await claudeSettingsManager.removeAllowedTool(workspacePath, claudePattern);
      logger.main.info('[PermissionHandlers] Allowed URL pattern removed from Claude settings:', claudePattern);
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to remove allowed URL pattern:', error);
      throw error;
    }
  });

  // Check if a specific URL is allowed (via Claude settings)
  safeHandle('permissions:isUrlAllowed', async (_event, workspacePath: string, url: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }
    if (!url) {
      throw new Error('url is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      const settings = await claudeSettingsManager.getEffectiveSettings(workspacePath);
      const allowedPatterns = settings.permissions.allow.filter(p => p.startsWith('WebFetch'));

      // Check for wildcard (all URLs allowed)
      if (allowedPatterns.includes('WebFetch')) {
        return true;
      }

      // Check for domain match
      try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;

        for (const pattern of allowedPatterns) {
          const match = pattern.match(/^WebFetch\(domain:(.+)\)$/);
          if (!match) continue;

          const domainPattern = match[1];

          // Exact match
          if (domainPattern === hostname) {
            return true;
          }

          // Wildcard match: *.example.com matches sub.example.com but not example.com
          if (domainPattern.startsWith('*.')) {
            const suffix = domainPattern.slice(1); // ".example.com"
            if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
              return true;
            }
          }
        }

        return false;
      } catch {
        return false;
      }
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to check if URL is allowed:', error);
      throw error;
    }
  });

  // Check if all URLs are allowed (wildcard pattern in Claude settings)
  safeHandle('permissions:isAllUrlsAllowed', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      const settings = await claudeSettingsManager.getEffectiveSettings(workspacePath);
      return settings.permissions.allow.includes('WebFetch');
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to check all URLs allowed:', error);
      throw error;
    }
  });

  // Allow all URLs (add wildcard pattern to Claude settings)
  safeHandle('permissions:allowAllUrls', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      await claudeSettingsManager.addAllowedTool(workspacePath, 'WebFetch');
      logger.main.info('[PermissionHandlers] All URLs allowed for workspace');
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to allow all URLs:', error);
      throw error;
    }
  });

  // Revoke "allow all URLs" permission (remove wildcard from Claude settings)
  safeHandle('permissions:revokeAllUrlsPermission', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    try {
      const claudeSettingsManager = ClaudeSettingsManager.getInstance();
      await claudeSettingsManager.removeAllowedTool(workspacePath, 'WebFetch');
      logger.main.info('[PermissionHandlers] All URLs permission revoked');
      broadcastPermissionChange(workspacePath);
      return { success: true };
    } catch (error) {
      logger.main.error('[PermissionHandlers] Failed to revoke all URLs permission:', error);
      throw error;
    }
  });

  // Permission evaluation is now handled by Claude SDK - these handlers are no longer needed
  // The SDK evaluates permissions via canUseTool callback in ClaudeCodeProvider

  logger.main.info('[PermissionHandlers] Permission handlers registered');
}
