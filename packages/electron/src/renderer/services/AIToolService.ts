/**
 * AIToolService - Centralized handler for all AI tool execution in the renderer process
 *
 * This service consolidates all AI tool IPC handlers that were previously scattered
 * throughout App.tsx. It provides a clean interface between the main process tool
 * executor and the actual tool implementations.
 */

import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import type { DiffResult } from '@nimbalyst/runtime/ai/server/types';

export interface ToolExecutionRequest {
  toolName: string;
  args: any;
  resultChannel: string;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
}

/**
 * AIToolService handles execution of AI tools in the renderer process.
 * Tools are categorized into:
 * - Document tools: Operate on the current editor content (applyDiff, getDocumentContent, etc.)
 * - File tools: File system operations (createDocument, etc.)
 */
export class AIToolService {
  private getContentFn: (() => string) | null = null;
  private handleWorkspaceFileSelectFn: ((filePath: string) => Promise<void>) | null = null;

  /**
   * Set the function to get current document content from the editor
   */
  setGetContentFunction(fn: () => string): void {
    this.getContentFn = fn;
  }

  /**
   * Set the function to handle workspace file selection (switching files)
   */
  setHandleWorkspaceFileSelectFunction(fn: (filePath: string) => Promise<void>): void {
    this.handleWorkspaceFileSelectFn = fn;
  }

  /**
   * Register createDocument method on aiChatBridge so runtime can call it
   */
  registerBridgeMethods(): void {
    if (typeof window !== 'undefined' && (window as any).aiChatBridge) {
      const bridge = (window as any).aiChatBridge;

      // Register createDocument on the bridge
      bridge.createDocument = async (args: {
        filePath: string;
        initialContent?: string;
        switchToFile?: boolean;
      }) => {
        return await this.executeCreateDocument(args);
      };

      // console.log('[AIToolService] Registered createDocument on aiChatBridge');
    }
  }

  /**
   * Execute a tool by name with given arguments
   */
  async executeTool(toolName: string, args: any): Promise<any> {
    // console.log(`[AIToolService] Executing tool: ${toolName}`);

    switch (toolName) {
      // Document editing tools
      case 'applyDiff':
        return await this.executeApplyDiff(args);
      case 'getDocumentContent':
        return await this.executeGetDocumentContent(args);
      case 'updateFrontmatter':
        return await this.executeUpdateFrontmatter(args);

      // File operation tools
      case 'createDocument':
        return await this.executeCreateDocument(args);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Apply diff replacements to the current document
   */
  private async executeApplyDiff(args: { replacements: Array<{ oldText: string; newText: string }>; targetFilePath?: string }): Promise<DiffResult> {
    // console.log('[AIToolService] applyDiff:', args.replacements?.length, 'replacements', 'targetFilePath:', args.targetFilePath);

    if (!args?.replacements || !Array.isArray(args.replacements)) {
      throw new Error('applyDiff requires replacements array');
    }

    // SAFETY: Require explicit targetFilePath - no fallbacks allowed
    if (!args.targetFilePath) {
      throw new Error('applyDiff requires explicit targetFilePath parameter - no target file specified');
    }

    const targetFilePath = args.targetFilePath;

    const result = await editorRegistry.applyReplacements(targetFilePath, args.replacements);

    if (!result?.success) {
      throw new Error(result?.error || 'Failed to apply diff');
    }

    return result;
  }

  /**
   * Get current document content
   */
  private async executeGetDocumentContent(args: any): Promise<{ content: string }> {
    // console.log('[AIToolService] getDocumentContent');

    if (!this.getContentFn) {
      throw new Error('getContent function not set');
    }

    const content = this.getContentFn();
    return { content: content || '' };
  }

  /**
   * Update frontmatter in the current document
   */
  private async executeUpdateFrontmatter(args: { updates: Record<string, any>; targetFilePath?: string }): Promise<DiffResult> {
    // console.log('[AIToolService] updateFrontmatter:', args.updates, 'targetFilePath:', args.targetFilePath);

    if (!args?.updates) {
      throw new Error('updateFrontmatter requires updates object');
    }

    // SAFETY: Require explicit targetFilePath - no fallbacks allowed
    if (!args.targetFilePath) {
      throw new Error('updateFrontmatter requires explicit targetFilePath parameter - no target file specified');
    }

    const targetFilePath = args.targetFilePath;

    const { parseFrontmatter, serializeWithFrontmatter } = await import('@nimbalyst/runtime');
    const currentContent = editorRegistry.getContent(targetFilePath);
    const { data: existingData } = parseFrontmatter(currentContent);

    // Separate planStatus updates from other updates
    const PLAN_STATUS_KEYS = new Set([
      'planId', 'title', 'status', 'state', 'planType', 'priority',
      'owner', 'stakeholders', 'tags', 'created', 'updated', 'dueDate',
      'startDate', 'progress'
    ]);

    const normalizedUpdates: Record<string, unknown> = { ...args.updates };
    const planStatusUpdate: Record<string, unknown> = {};

    for (const key of Object.keys(normalizedUpdates)) {
      if (PLAN_STATUS_KEYS.has(key)) {
        planStatusUpdate[key] = normalizedUpdates[key];
        delete normalizedUpdates[key];
      }
    }

    // Merge planStatus updates if any exist
    if (Object.keys(planStatusUpdate).length > 0) {
      const existingPlanStatus = existingData?.planStatus;
      const existingPlanStatusObject =
        existingPlanStatus && typeof existingPlanStatus === 'object' && !Array.isArray(existingPlanStatus)
          ? (existingPlanStatus as Record<string, any>)
          : {};

      normalizedUpdates.planStatus = this.mergeFrontmatterData(
        existingPlanStatusObject,
        planStatusUpdate
      );
    }

    // Merge with existing frontmatter
    const mergedData = this.mergeFrontmatterData(existingData ?? {}, normalizedUpdates);

    // Generate new frontmatter block (`\r?\n` tolerates Windows CRLF; nimbalyst#68)
    const frontmatterMatch = currentContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const newFrontmatterBlockBase = serializeWithFrontmatter('', mergedData);

    let replacements: Array<{ oldText: string; newText: string }>;

    if (frontmatterMatch) {
      // Replace existing frontmatter
      const originalFrontmatterBlock = frontmatterMatch[0];
      const trailingNewlines = originalFrontmatterBlock.match(/\n*$/)?.[0] ?? '';
      const trimmedBase = newFrontmatterBlockBase.replace(/\s*$/, '');
      const newFrontmatterBlock = `${trimmedBase}${trailingNewlines || '\n'}`;

      replacements = [{
        oldText: originalFrontmatterBlock,
        newText: newFrontmatterBlock,
      }];
    } else {
      // Add new frontmatter at the beginning
      const trimmedBase = newFrontmatterBlockBase.replace(/\s*$/, '');
      const newFrontmatterBlock = `${trimmedBase}\n\n`;
      replacements = [{
        oldText: currentContent,
        newText: `${newFrontmatterBlock}${currentContent}`,
      }];
    }

    // Apply the replacement
    const result = await editorRegistry.applyReplacements(targetFilePath, replacements);

    if (!result?.success) {
      throw new Error(result?.error || 'Failed to update frontmatter');
    }

    return result;
  }

  /**
   * Create a new document
   */
  private async executeCreateDocument(args: {
    filePath: string;
    initialContent?: string;
    switchToFile?: boolean;
  }): Promise<{ success: boolean; filePath?: string; error?: string }> {
    // console.log('[AIToolService] createDocument:', args.filePath, 'switchToFile:', args.switchToFile);

    if (!args?.filePath) {
      throw new Error('createDocument requires filePath');
    }

    if (!window.electronAPI) {
      throw new Error('Electron API not available');
    }

    // Create the document via IPC
    const result = await window.electronAPI.invoke('create-document', args.filePath, args.initialContent);

    if (!result.success) {
      throw new Error(result.error || 'Failed to create document');
    }

    // Switch to the new file if requested
    if (args.switchToFile !== false && result.filePath) {
      if (!this.handleWorkspaceFileSelectFn) {
        console.warn('[AIToolService] Cannot switch to file: handleWorkspaceFileSelect not set');
      } else {
        // console.log('[AIToolService] Switching to new file:', result.filePath);
        await this.handleWorkspaceFileSelectFn(result.filePath);
      }
    }

    return result;
  }

  /**
   * Merge frontmatter data recursively
   */
  private mergeFrontmatterData(
    existing: Record<string, any>,
    updates: Record<string, any>
  ): Record<string, any> {
    const result: Record<string, any> = { ...existing };

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        continue;
      }

      if (Array.isArray(value)) {
        result[key] = value;
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const currentValue = result[key];
        const nestedExisting = (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue))
          ? currentValue
          : {};

        result[key] = this.mergeFrontmatterData(nestedExisting, value);
        continue;
      }

      result[key] = value;
    }

    return result;
  }
}

// Singleton instance
export const aiToolService = new AIToolService();
