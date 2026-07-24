/**
 * IPC handlers for data model-related operations.
 *
 * Provides handlers for:
 * - Listing data model files in workspace
 * - Creating new data model files
 * - Capturing screenshots of data models
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeHandle, removeHandler } from '../utils/ipcRegistry';
import { getWindowId, windowStates } from '../window/WindowManager';

/**
 * Register IPC handlers for data model operations.
 */
export function registerDataModelHandlers(): void {
  // List all data model files in the workspace
  safeHandle('datamodel:list-datamodels', async (event) => {
    try {
      // Get the workspace path from the sender window
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow) {
        return [];
      }

      // Get workspace path from window state
      const windowId = getWindowId(senderWindow);
      if (windowId === null) {
        return [];
      }
      const state = windowStates.get(windowId);
      const workspacePath = state?.workspacePath;

      if (!workspacePath) {
        return [];
      }

      // Recursively find all .prisma files
      const dataModels: Array<{
        absolutePath: string;
        relativePath: string;
        name: string;
      }> = [];

      async function scanDirectory(dir: string): Promise<void> {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            // Skip hidden directories and node_modules
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                await scanDirectory(fullPath);
              }
            } else if (entry.name.endsWith('.prisma') && workspacePath) {
              dataModels.push({
                absolutePath: fullPath,
                relativePath: path.relative(workspacePath, fullPath),
                name: entry.name,
              });
            }
          }
        } catch (error) {
          // Ignore permission errors
        }
      }

      await scanDirectory(workspacePath);
      return dataModels;
    } catch (error) {
      logger.main.error('[DataModelHandlers] Failed to list data models:', error);
      return [];
    }
  });

  // Create a new data model file
  safeHandle(
    'datamodel:create-datamodel',
    async (_event, name: string, directory: string) => {
      try {
        // Ensure name doesn't already have extension
        const baseName = name.replace(/\.prisma$/, '');
        const fileName = `${baseName}.prisma`;
        const filePath = path.join(directory, fileName);

        // Check if file already exists
        try {
          await fs.access(filePath);
          return {
            success: false,
            error: `Data model "${fileName}" already exists`,
          };
        } catch {
          // File doesn't exist, which is what we want
        }

        // Create a basic data model template with Nimbalyst metadata
        const template = `// @nimbalyst {"viewport":{"x":0,"y":0,"zoom":1},"positions":{},"entityViewMode":"standard"}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// Add your models here
// Example:
// model User {
//   id        Int      @id @default(autoincrement())
//   email     String   @unique
//   name      String?
//   createdAt DateTime @default(now())
// }
`;

        await fs.writeFile(filePath, template, 'utf-8');
        logger.main.info(`[DataModelHandlers] Created data model: ${filePath}`);

        return { success: true, filePath };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        logger.main.error(`[DataModelHandlers] Failed to create data model: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }
    },
  );

  // Capture data model screenshot and save to file
  // Uses the generic screenshot service via IPC
  safeHandle(
    'datamodel:capture-and-save-screenshot',
    async (event, dataModelPath: string, outputPath: string) => {
      logger.main.info(`[DataModelHandlers] Capturing screenshot: ${dataModelPath} -> ${outputPath}`);

      try {
        // Get the sender window to request screenshot from renderer
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (!senderWindow) {
          return {
            success: false,
            error: 'No window found',
          };
        }

        // Request screenshot capture from the renderer process
        // The generic screenshot service routes to the appropriate capability
        const result = await new Promise<{
          success: boolean;
          imageBase64?: string;
          error?: string;
        }>((resolve) => {
          const requestId = `screenshot-${Date.now()}`;
          const timeout = setTimeout(() => {
            removeHandler('screenshot:result-' + requestId);
            resolve({ success: false, error: 'Screenshot request timed out' });
          }, 30000); // 30 second timeout for headless render

          // Set up one-time handler for result
          const handler = (_event: Electron.IpcMainInvokeEvent, payload: {
            requestId: string;
            success: boolean;
            imageBase64?: string;
            error?: string;
          }) => {
            if (payload.requestId === requestId) {
              clearTimeout(timeout);
              removeHandler('screenshot:result-' + requestId);
              resolve(payload);
            }
          };

          safeHandle('screenshot:result-' + requestId, handler);

          // Request screenshot from renderer using generic channel
          senderWindow.webContents.send('screenshot:capture', {
            requestId,
            filePath: dataModelPath,
          });
        });

        if (!result.success || !result.imageBase64) {
          return {
            success: false,
            error: result.error || 'Failed to capture screenshot',
          };
        }

        // Ensure the output directory exists
        const outputDir = path.dirname(outputPath);
        await fs.mkdir(outputDir, { recursive: true });

        // Convert base64 to buffer and write to file
        const imageBuffer = Buffer.from(result.imageBase64, 'base64');
        await fs.writeFile(outputPath, imageBuffer);

        logger.main.info(`[DataModelHandlers] Screenshot saved: ${outputPath}`);

        return { success: true };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        logger.main.error(`[DataModelHandlers] Failed to capture and save screenshot: ${errorMessage}`);
        return {
          success: false,
          error: errorMessage,
        };
      }
    },
  );

  // Get relative path from one file to another
  safeHandle(
    'datamodel:get-relative-path',
    (_event, fromPath: string, toPath: string) => {
      try {
        const fromDir = path.dirname(fromPath);
        return path.relative(fromDir, toPath);
      } catch (error) {
        logger.main.error('[DataModelHandlers] Failed to get relative path:', error);
        return toPath;
      }
    },
  );

  logger.main.info('[DataModelHandlers] Data model handlers registered');
}
