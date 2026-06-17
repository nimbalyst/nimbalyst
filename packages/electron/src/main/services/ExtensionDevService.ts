import { ClaudeCodeProvider, OpenAICodexProvider, OpenAICodexACPProvider, OpenCodeProvider } from '@nimbalyst/runtime/ai/server';
import { ClaudeCliLauncherConfig } from './ai/claudeCliLauncherSingleton';
import { BrowserWindow } from 'electron';
import {
  startExtensionDevServer,
  setExtensionManagementFns,
  shutdownExtensionDevServer
} from '../mcp/extensionDevServer';
import { isExtensionDevToolsEnabled } from '../utils/store';

/**
 * Service to manage the Extension Developer Kit MCP server
 *
 * This runs in the electron main process and provides tools for:
 * - Building extensions (npm run build)
 * - Installing extensions into the running Nimbalyst
 * - Hot-reloading extensions during development
 * - Uninstalling extensions
 */
export class ExtensionDevService {
  private static instance: ExtensionDevService | null = null;
  private serverPort: number | null = null;
  private starting: Promise<void> | null = null;
  private started: boolean = false;

  private constructor() {}

  public static getInstance(): ExtensionDevService {
    if (!ExtensionDevService.instance) {
      ExtensionDevService.instance = new ExtensionDevService();
    }
    return ExtensionDevService.instance;
  }

  /**
   * Start the extension dev MCP server and configure agent providers.
   * Only starts if extension dev tools are enabled in settings.
   */
  public async start(): Promise<void> {
    // Check if extension dev tools are enabled
    if (!isExtensionDevToolsEnabled()) {
      console.log('[ExtensionDevService] Extension dev tools disabled in settings, skipping start');
      return;
    }

    // If already started, do nothing
    if (this.started) {
      return;
    }

    // If already starting, wait for it
    if (this.starting) {
      await this.starting;
      return;
    }

    this.starting = (async () => {
      try {
        // Set the extension management functions that connect to the IPC handlers
        setExtensionManagementFns({
          install: async (extensionPath: string) => {
            console.log(`[ExtensionDevService] Install requested for: ${extensionPath}`);

            try {
              // Step 1: Create symlink via IPC handler
              // We need to invoke the IPC handler directly since we're in main process
              const installResult = await this.invokeDevInstall(extensionPath);

              if (!installResult.success) {
                return {
                  success: false,
                  extensionId: undefined,
                  error: installResult.error || 'Failed to install extension'
                };
              }

              // Step 2: Notify all renderer windows to load the extension
              await this.invokeDevReload(installResult.extensionId!, extensionPath);

              return {
                success: true,
                extensionId: installResult.extensionId,
                error: undefined
              };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              return {
                success: false,
                extensionId: undefined,
                error: errorMessage
              };
            }
          },

          uninstall: async (extensionId: string) => {
            console.log(`[ExtensionDevService] Uninstall requested for: ${extensionId}`);

            try {
              // Step 1: Notify all renderer windows to unload the extension
              await this.invokeDevUnload(extensionId);

              // Step 2: Remove symlink via IPC handler
              const uninstallResult = await this.invokeDevUninstall(extensionId);

              return {
                success: uninstallResult.success,
                error: uninstallResult.error
              };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              return {
                success: false,
                error: errorMessage
              };
            }
          },

          reload: async (extensionId: string, extensionPath?: string) => {
            console.log(`[ExtensionDevService] Reload requested for: ${extensionId}`);

            if (!extensionPath) {
              return {
                success: false,
                error: 'extensionPath is required for reload'
              };
            }

            try {
              // Notify all renderer windows to reload the extension
              await this.invokeDevReload(extensionId, extensionPath);

              return {
                success: true,
                error: undefined
              };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              return {
                success: false,
                error: errorMessage
              };
            }
          }
        });

        // Start the MCP server
        const { port } = await startExtensionDevServer();
        this.serverPort = port;
        console.log(`[ExtensionDevService] MCP server started on port ${port}`);

        // Inject the port into agent providers so they can configure the MCP server
        ClaudeCodeProvider.setExtensionDevServerPort(port);
        OpenAICodexProvider.setExtensionDevServerPort(port);
        OpenAICodexACPProvider.setExtensionDevServerPort(port);
        OpenCodeProvider.setExtensionDevServerPort(port);
        ClaudeCliLauncherConfig.setExtensionDevServerPort(port);

        this.started = true;
      } catch (error) {
        console.error('[ExtensionDevService] Failed to start:', error);
        throw error;
      } finally {
        this.starting = null;
      }
    })();

    await this.starting;
  }

  /**
   * Shutdown the extension dev MCP server
   */
  public async shutdown(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      await shutdownExtensionDevServer();
      ClaudeCodeProvider.setExtensionDevServerPort(null);
      OpenAICodexProvider.setExtensionDevServerPort(null);
      OpenAICodexACPProvider.setExtensionDevServerPort(null);
      OpenCodeProvider.setExtensionDevServerPort(null);
      this.serverPort = null;
      this.started = false;
      console.log('[ExtensionDevService] Shutdown complete');
    } catch (error) {
      console.error('[ExtensionDevService] Error during shutdown:', error);
    }
  }

  // ============================================================================
  // Private helper methods for invoking IPC handlers from main process
  // ============================================================================

  /**
   * Invoke the dev-install IPC handler to create symlink
   */
  private async invokeDevInstall(extensionPath: string): Promise<{ success: boolean; extensionId?: string; symlinkPath?: string; error?: string }> {
    return new Promise((resolve) => {
      // Create a one-time handler for the response
      const channelId = `extensions:dev-install-internal-${Date.now()}`;

      // We can't use ipcMain.invoke from main process, so we simulate it
      // by directly calling the handler logic
      const fs = require('fs/promises');
      const path = require('path');
      const { app } = require('electron');

      (async () => {
        try {
          const normalizedPath = path.resolve(extensionPath);
          const manifestPath = path.join(normalizedPath, 'manifest.json');

          // Verify manifest exists
          try {
            await fs.access(manifestPath);
          } catch {
            resolve({ success: false, error: `No manifest.json found at ${normalizedPath}` });
            return;
          }

          // Read manifest to get extension ID
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);
          const extensionId = manifest.id;

          if (!extensionId) {
            resolve({ success: false, error: 'manifest.json missing required "id" field' });
            return;
          }

          // Create symlink in user extensions directory
          const userDataPath = process.env.PLAYWRIGHT === '1'
            ? path.join(app.getPath('temp'), 'nimbalyst-test-extensions')
            : app.getPath('userData');
          const userExtDir = path.join(userDataPath, 'extensions');
          await fs.mkdir(userExtDir, { recursive: true });

          const symlinkPath = path.join(userExtDir, path.basename(normalizedPath));

          // Remove existing symlink if present
          try {
            const stat = await fs.lstat(symlinkPath);
            if (stat.isSymbolicLink() || stat.isDirectory()) {
              await fs.rm(symlinkPath, { recursive: true, force: true });
            }
          } catch {
            // Doesn't exist, that's fine
          }

          // Create symlink
          await fs.symlink(normalizedPath, symlinkPath, 'junction');
          console.log(`[ExtensionDevService] Created dev extension symlink: ${symlinkPath} -> ${normalizedPath}`);

          resolve({ success: true, extensionId, symlinkPath });
        } catch (error) {
          resolve({ success: false, error: String(error) });
        }
      })();
    });
  }

  /**
   * Invoke the dev-uninstall IPC handler to remove symlink
   */
  private async invokeDevUninstall(extensionId: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const fs = require('fs/promises');
      const path = require('path');
      const { app } = require('electron');

      (async () => {
        try {
          const userDataPath = process.env.PLAYWRIGHT === '1'
            ? path.join(app.getPath('temp'), 'nimbalyst-test-extensions')
            : app.getPath('userData');
          const userExtDir = path.join(userDataPath, 'extensions');

          // Find the extension directory (could be a symlink)
          let entries;
          try {
            entries = await fs.readdir(userExtDir, { withFileTypes: true });
          } catch {
            resolve({ success: false, error: 'User extensions directory not found' });
            return;
          }

          for (const entry of entries) {
            const entryPath = path.join(userExtDir, entry.name);

            // Check if this entry matches the extension ID
            const manifestPath = path.join(entryPath, 'manifest.json');
            try {
              const manifestContent = await fs.readFile(manifestPath, 'utf-8');
              const manifest = JSON.parse(manifestContent);

              if (manifest.id === extensionId) {
                // Found it - remove the symlink/directory
                await fs.rm(entryPath, { recursive: true, force: true });
                console.log(`[ExtensionDevService] Removed dev extension: ${extensionId} at ${entryPath}`);
                resolve({ success: true });
                return;
              }
            } catch {
              // Not a valid extension directory, skip
            }
          }

          resolve({ success: false, error: `Extension ${extensionId} not found in user extensions` });
        } catch (error) {
          resolve({ success: false, error: String(error) });
        }
      })();
    });
  }

  /**
   * Broadcast reload message to all renderer windows
   */
  private async invokeDevReload(extensionId: string, extensionPath: string): Promise<void> {
    console.log(`[ExtensionDevService] Broadcasting extension reload: ${extensionId} from ${extensionPath}`);

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('extension:dev-reload', { extensionId, extensionPath });
      }
    }
  }

  /**
   * Broadcast unload message to all renderer windows
   */
  private async invokeDevUnload(extensionId: string): Promise<void> {
    console.log(`[ExtensionDevService] Broadcasting extension unload: ${extensionId}`);

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('extension:dev-unload', { extensionId });
      }
    }
  }
}
