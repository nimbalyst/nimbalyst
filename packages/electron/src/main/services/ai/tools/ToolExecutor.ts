/**
 * ToolExecutor - Handles execution of tools with proper IPC communication
 */

import { WebContents, ipcMain, BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import type { DiffArgs, DiffResult, ToolDefinition } from '@nimbalyst/runtime/ai/server/types';
import { toolRegistry } from './ToolRegistry';
import { logger } from '../../../utils/logger';
import { sessionFileTracker } from '../../SessionFileTracker';
import { addGitignoreBypass } from '../../../file/WorkspaceEventBus';
import { extractFilePath } from './extractFilePath';
import {AnalyticsService} from "../../analytics/AnalyticsService.ts";

const LOG_PREVIEW_LENGTH = 400;
const analytics = AnalyticsService.getInstance();

function previewForLog(value?: string, max: number = LOG_PREVIEW_LENGTH): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export class ToolExecutor extends EventEmitter {
  private webContents: WebContents;
  private pendingExecutions: Map<string, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private sessionId?: string;
  private workspaceId?: string;

  constructor(webContents: WebContents, sessionId?: string, workspaceId?: string) {
    super();
    this.webContents = webContents;
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.setupHandlers();
  }

  private bucketContentLength(length: number): string {
    if (length < 100) return '0-99';
    if (length < 500) return '100-499';
    if (length < 1000) return '500-999';
    return '1000+';
  }
  
  private setupHandlers(): void {
    // Clean up any existing handlers to avoid duplicates
    ipcMain.removeAllListeners('tool:execution:result');
  }
  
  /**
   * Execute applyDiff tool
  */
  async applyDiff(args: DiffArgs & { targetFilePath?: string }): Promise<DiffResult> {
    analytics.sendEvent('apply_diff_tool');
    const resultChannel = `applyDiff-result-${Date.now()}`;
    const replacementCount = Array.isArray(args?.replacements) ? args.replacements.length : undefined;
    logger.ai.info('[ToolExecutor] applyDiff invoked', {
      replacements: replacementCount,
      targetFilePath: args.targetFilePath,
      preview: previewForLog(JSON.stringify(args ?? {}))
    });
    if (replacementCount === undefined || replacementCount === 0) {
      logger.ai.warn('[ToolExecutor] applyDiff called without replacements');
    }

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(resultChannel);
        logger.ai.error('[ToolExecutor] applyDiff timed out');
        reject(new Error('applyDiff execution timed out'));
      }, 30000);

      // Set up one-time listener for result
      ipcMain.once(resultChannel, (event, result: DiffResult) => {
        clearTimeout(timeout);
        logger.ai.info('[ToolExecutor] applyDiff result received', result);
        resolve(result);
      });

      // Pre-register bypass for the target file
      if (this.workspaceId && args.targetFilePath) {
        addGitignoreBypass(this.workspaceId, args.targetFilePath);
      }

      // Send to renderer with explicit targetFilePath
      console.log(`[ToolExecutor] Sending applyDiff to renderer with targetFilePath:`, args.targetFilePath);
      this.webContents.send('ai:applyDiff', {
        replacements: args.replacements,
        resultChannel,
        targetFilePath: args.targetFilePath
      });
    });
  }
  
  /**
   * Execute streamContent tool
   */
  async streamContent(args: {
    content: string;
    position?: string;
    insertAfter?: string;
    mode?: string;
    targetFilePath?: string;
  }): Promise<void> {
    const streamId = `stream-${Date.now()}`;

    // Determine position type for analytics
    let positionType: 'cursor' | 'end' | 'after-selection';
    if (args.insertAfter) {
      positionType = 'after-selection';
    } else if (args.position === 'cursor') {
      positionType = 'cursor';
    } else {
      positionType = 'end';
    }

    // Track ai_stream_content_used analytics event
    analytics.sendEvent('ai_stream_content_used', {
      position: positionType,
      contentLength: this.bucketContentLength(args.content.length)
    });

    // Pre-register bypass for the target file
    if (this.workspaceId && args.targetFilePath) {
      addGitignoreBypass(this.workspaceId, args.targetFilePath);
    }

    // Start streaming - include targetFilePath so renderer knows which document to target
    // This prevents race conditions if user switches tabs while waiting for AI response
    if (!args.targetFilePath) {
      logger.ai.warn('[ToolExecutor] streamContent called without targetFilePath - edit may go to wrong document');
    }
    this.webContents.send('ai:streamEditStart', {
      id: streamId,
      position: args.position || (args.insertAfter ? undefined : 'cursor'),
      insertAfter: args.insertAfter,
      mode: args.mode || 'append',
      insertAtEnd: false,
      targetFilePath: args.targetFilePath
    });

    // Stream content in chunks
    const chunkSize = 50;
    const content = args.content;

    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, Math.min(i + chunkSize, content.length));
      this.webContents.send('ai:streamEditContent', chunk);

      // Small delay between chunks for smooth streaming
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // End streaming
    this.webContents.send('ai:streamEditEnd', { id: streamId });

    // Track file interaction after streaming completes
    // Also attach file watcher for the edited file
    if (this.sessionId && this.workspaceId && args.targetFilePath) {
      try {
        // Get the BrowserWindow from webContents to attach file watchers
        const window = BrowserWindow.fromWebContents(this.webContents);

        console.log('[ToolExecutor] Tracking streamContent file interaction');
        await sessionFileTracker.trackToolExecution(
          this.sessionId,
          this.workspaceId,
          'streamContent',
          { file_path: args.targetFilePath, content: args.content },
          { success: true, linesAdded: args.content.split('\n').length },
          undefined,
          window  // Pass window to enable file watcher attachment
        );
        console.log('[ToolExecutor] streamContent tracking completed');
      } catch (error) {
        logger.main.warn('[ToolExecutor] Failed to track streamContent:', error);
        console.error('[ToolExecutor] streamContent tracking error:', error);
      }
    }
  }

  /**
   * Execute getDocumentContent tool
   */
  async getDocumentContent(args: { filePath?: string }): Promise<{ content: string }> {
    const resultChannel = `getDocumentContent-result-${Date.now()}`;
    logger.ai.info('[ToolExecutor] getDocumentContent invoked', {
      filePath: args?.filePath
    });

    // SAFETY: Require explicit filePath
    if (!args?.filePath) {
      throw new Error('getDocumentContent requires filePath parameter - no target file specified');
    }

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(resultChannel);
        logger.ai.error('[ToolExecutor] getDocumentContent timed out');
        reject(new Error('getDocumentContent execution timed out'));
      }, 5000);

      // Set up one-time listener for result
      ipcMain.once(resultChannel, (event, result: { content: string }) => {
        clearTimeout(timeout);
        logger.ai.info('[ToolExecutor] getDocumentContent result received', {
          contentLength: result?.content?.length || 0
        });
        resolve(result);
      });

      // Send to renderer with filePath
      this.webContents.send('ai:getDocumentContent', {
        filePath: args.filePath,
        resultChannel
      });
    });
  }

  /**
   * Execute updateFrontmatter tool
   */
  async updateFrontmatter(args: { filePath?: string; updates: Record<string, any> }): Promise<DiffResult> {
    const resultChannel = `updateFrontmatter-result-${Date.now()}`;
    logger.ai.info('[ToolExecutor] updateFrontmatter invoked', {
      filePath: args?.filePath,
      updates: args?.updates
    });

    // SAFETY: Require explicit filePath
    if (!args?.filePath) {
      throw new Error('updateFrontmatter requires filePath parameter - no target file specified');
    }

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(resultChannel);
        logger.ai.error('[ToolExecutor] updateFrontmatter timed out');
        reject(new Error('updateFrontmatter execution timed out'));
      }, 30000);

      // Set up one-time listener for result
      ipcMain.once(resultChannel, (event, result: DiffResult) => {
        clearTimeout(timeout);
        logger.ai.info('[ToolExecutor] updateFrontmatter result received', result);
        resolve(result);
      });

      // Send to renderer with filePath
      this.webContents.send('ai:updateFrontmatter', {
        filePath: args.filePath,
        updates: args.updates,
        resultChannel
      });
    });
  }

  /**
   * Execute createDocument tool
   */
  async createDocument(args: { filePath: string; initialContent?: string; switchToFile?: boolean }): Promise<any> {
    analytics.sendEvent('create_document_tool');
    const resultChannel = `createDocument-result-${Date.now()}`;
    logger.ai.info('[ToolExecutor] createDocument invoked', {
      filePath: args?.filePath,
      hasContent: !!args?.initialContent,
      switchToFile: args?.switchToFile !== false
    });

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(resultChannel);
        logger.ai.error('[ToolExecutor] createDocument timed out');
        reject(new Error('Tool createDocument execution timed out'));
      }, 10000);

      // Set up one-time listener for result
      ipcMain.once(resultChannel, (event, result: any) => {
        clearTimeout(timeout);
        logger.ai.info('[ToolExecutor] createDocument result received', result);
        resolve(result);
      });

      // Send to renderer
      this.webContents.send('ai:createDocument', {
        filePath: args.filePath,
        initialContent: args.initialContent,
        switchToFile: args.switchToFile !== false,
        resultChannel
      });
    });
  }

  /**
   * Execute any registered tool
   */
  async executeTool(name: string, args: any): Promise<any> {
    const tool = toolRegistry.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }

    // Pre-register gitignore bypass BEFORE tool execution so the watcher
    // picks up file changes even if the bypass registration from
    // SessionFileTracker arrives after the fs event.
    // Only for tools that write files — read-only tools (getDocumentContent,
    // searchFiles, etc.) should not register bypasses.
    const WRITE_TOOLS = ['applyDiff', 'streamContent', 'writeFile', 'editFile', 'createDocument', 'updateFrontmatter'];
    if (this.workspaceId && WRITE_TOOLS.includes(name)) {
      const filePath = extractFilePath(args);
      if (filePath) {
        addGitignoreBypass(this.workspaceId, filePath);
      }
    }

    let result: any;

    // Handle built-in tools
    switch (name) {
      case 'applyDiff':
        result = await this.applyDiff(args);
        break;
      case 'streamContent':
        result = await this.streamContent(args);
        break;
      case 'getDocumentContent':
        result = await this.getDocumentContent(args);
        break;
      case 'updateFrontmatter':
        result = await this.updateFrontmatter(args);
        break;
      case 'createDocument':
        result = await this.createDocument(args);
        break;
      default:
        // Check if tool has a handler (e.g., file tools)
        if (typeof tool.handler === 'function') {
          logger.ai.info(`[ToolExecutor] Executing tool with handler: ${name}`);
          try {
            // Pass the executor's workspaceId as context so handlers that
            // resolve workspace-scoped services (e.g. fileTools' search /
            // list / read) hit the per-path FileSystemService registry
            // instead of the runtime-global singleton — without this, an
            // inactive rail project's session would route through the
            // currently-visible project's service.
            result = await tool.handler(args, { workspacePath: this.workspaceId });
          } catch (error) {
            logger.ai.error(`[ToolExecutor] Tool ${name} execution failed:`, error);
            throw error;
          }
        } else {
          // Execute custom/renderer tool
          result = await this.executeCustomTool(tool, args);
        }
    }

    // Track file interactions after successful tool execution
    // Also attach file watchers for edited files to detect subsequent changes
    console.log('[ToolExecutor] Checking if should track file:', {
      hasSessionId: !!this.sessionId,
      hasWorkspaceId: !!this.workspaceId,
      toolName: name,
      sessionId: this.sessionId,
      workspaceId: this.workspaceId
    });

    if (this.sessionId && this.workspaceId) {
      try {
        // Get the BrowserWindow from webContents to attach file watchers
        const window = BrowserWindow.fromWebContents(this.webContents);

        console.log('[ToolExecutor] Calling sessionFileTracker.trackToolExecution');
        await sessionFileTracker.trackToolExecution(
          this.sessionId,
          this.workspaceId,
          name,
          args,
          result,
          undefined,
          window  // Pass window to enable file watcher attachment for edited files
        );
        console.log('[ToolExecutor] File tracking completed successfully');
      } catch (error) {
        // Log but don't fail - tracking is not critical
        logger.main.warn('[ToolExecutor] Failed to track file interaction:', error);
        console.error('[ToolExecutor] File tracking error:', error);
      }
    } else {
      console.warn('[ToolExecutor] Skipping file tracking - missing sessionId or workspaceId');
    }

    return result;
  }
  
  /**
   * Execute a custom/renderer tool
   */
  private async executeCustomTool(tool: ToolDefinition, args: any): Promise<any> {
    analytics.sendEvent('execute_custom_tool');
    const correlationId = `tool-${tool.name}-${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingExecutions.delete(correlationId);
        reject(new Error(`Tool ${tool.name} execution timed out`));
      }, 30000);
      
      // Store pending execution
      this.pendingExecutions.set(correlationId, {
        resolve,
        reject,
        timeout
      });
      
      // Send execution request to renderer
      this.webContents.send('ai:executeTool', {
        toolName: tool.name,
        args,
        correlationId
      });
    });
  }
  
  /**
   * Handle tool execution result from renderer
   */
  handleToolResult(correlationId: string, result: any, error?: string): void {
    const pending = this.pendingExecutions.get(correlationId);
    if (!pending) return;
    
    clearTimeout(pending.timeout);
    this.pendingExecutions.delete(correlationId);
    
    if (error) {
      pending.reject(new Error(error));
    } else {
      pending.resolve(result);
    }
  }
  
  /**
   * Clean up resources
   */
  destroy(): void {
    // Clear all pending executions
    for (const [id, pending] of this.pendingExecutions) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('ToolExecutor destroyed'));
    }
    this.pendingExecutions.clear();
    this.removeAllListeners();
  }
}
