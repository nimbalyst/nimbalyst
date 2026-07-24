import { detectStreamingIntent, parseStreamingChunk, StreamingEditRequest } from './aiStreamProtocol';
import { logger } from '../utils/logger';
import type { DocumentContext, Message, SessionData } from '@nimbalyst/runtime/ai/server/types';
import { editorRegistry } from '@nimbalyst/runtime/ai/EditorRegistry';
import { isCollabUri } from '../utils/collabUri';

const LOG_PREVIEW_LENGTH = 400;

const previewForLog = (value?: string, max: number = LOG_PREVIEW_LENGTH): string => {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

// DocumentContext is now imported from runtime package

interface EditRequest {
  type: 'edit' | 'insert' | 'delete' | 'replace' | 'stream' | 'diff';
  file: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  content: string;
  preview: boolean;
  replacements?: any[];  // For diff type edits
}

// Message type is now imported from runtime package
// Using SessionData directly from runtime package

class AIApi {
  private listeners: Map<string, Set<Function>> = new Map();
  private isStreamingEdit: boolean = false;
  private streamingConfig: any = null;
  private accumulatedContent: string = '';
  private streamStartDetected: boolean = false;
  private streamBuffer: string = ''; // Buffer for detecting split markers
  // Removed defaultProvider - should always be specified explicitly

  constructor() {
    // Set up IPC listener for errors
    window.electronAPI.onAIError((error: any) => {
      // Serialize explicitly: the file-based console capture stringifies raw
      // objects as "[object Object]", which hid the real error in #614.
      const detail = typeof error === 'string'
        ? error
        : JSON.stringify({
            message: error?.message,
            sessionId: error?.sessionId,
            isAuthError: error?.isAuthError,
            type: error?.type,
          });
      console.error('AI API Error:', detail);

      // Emit error event so UI can handle it
      this.emit('error', error);
    });

    // Set up IPC listeners for streaming edit events from AI service
    window.electronAPI.onAIStreamEditStart((data: any) => {
      logger.streaming.info('🚀 Stream edit started from AI service:', { sessionId: data.sessionId });
      this.emit('streamEditStart', data);
    });

    window.electronAPI.onAIStreamEditContent((data: any) => {
      // Handle both old format (string) and new format ({ sessionId, content })
      const content = typeof data === 'string' ? data : data.content;
      const sessionId = typeof data === 'object' ? data.sessionId : undefined;
      logger.streaming.info('Stream edit content from AI service:', { sessionId, preview: content?.substring(0, 50) });
      this.emit('streamEditContent', data);
    });

    window.electronAPI.onAIStreamEditEnd((data: any) => {
      logger.streaming.info('🏁 Stream edit ended from AI service:', { sessionId: data?.sessionId });
      this.emit('streamEditEnd', data);
    });

    // Set up IPC listeners for streaming responses (both legacy and new)
    const handleStreamResponse = (data: any) => {
      if (data?.edits && !data.isComplete) {
        const counts = Array.isArray(data.edits)
          ? data.edits.map((edit: any) => Array.isArray(edit?.replacements) ? edit.replacements.length : 0)
          : [];
        logger.api.info('AI provided edits mid-stream', counts);
      }

      // Stream response received - emit will handle logging

      // Accumulate content to check for streaming markers
      if (data.partial) {
        this.accumulatedContent += data.partial;
      }

      // Check if this is a streaming edit response
      if (!this.isStreamingEdit && !this.streamStartDetected) {
        // Check accumulated content for streaming marker
        const { isStreaming, streamConfig, cleanContent } = detectStreamingIntent(this.accumulatedContent);
        // Stream detection handled

        if (isStreaming) {
          logger.streaming.info('🚀 STREAMING MODE ACTIVATED', streamConfig);
          this.isStreamingEdit = true;
          this.streamStartDetected = true;
          this.streamingConfig = streamConfig;

          // Clear accumulated content and keep only clean content
          this.accumulatedContent = cleanContent;

          // Emit streaming edit start event
          logger.streaming.info('Emitting streamEditStart event with config:', streamConfig);
          this.emit('streamEditStart', streamConfig);

          // If there's content after the marker, process it
          // Add a small delay to allow React state to update
          if (cleanContent) {
            setTimeout(() => {
              if (!this.isStreamingEdit) {
                logger.streaming.info('Streaming was cancelled, not emitting initial content');
                return;
              }

              // Check if we have the end marker already
              if (cleanContent.includes('<!-- STREAM_END -->')) {
                const contentBeforeEnd = cleanContent.split('<!-- STREAM_END -->')[0];
                logger.streaming.info('Found complete stream in one chunk');
                this.emit('streamEditContent', contentBeforeEnd);
                this.emit('streamEditEnd', {});
                this.isStreamingEdit = false;
                this.streamingConfig = null;
                this.accumulatedContent = '';
                this.streamStartDetected = false;
              } else {
                logger.streaming.info('Emitting initial clean content after delay:', cleanContent.substring(0, 100));
                this.emit('streamEditContent', cleanContent);
                this.accumulatedContent = ''; // Clear for next chunks
              }
            }, 100); // 100ms delay to ensure React state updates
          }
          return;
        }
      }

      // If we're in streaming edit mode, handle the content
      if (this.isStreamingEdit && data.partial) {
        // Add to buffer to check for split markers
        this.streamBuffer += data.partial;

        // Check if we have a complete end marker
        if (this.streamBuffer.includes('<!-- STREAM_END -->')) {
          // Extract content before the end marker
          const endIndex = this.streamBuffer.indexOf('<!-- STREAM_END -->');
          const contentToStream = this.streamBuffer.substring(0, endIndex);

          // Only emit if there's actual content
          if (contentToStream.trim()) {
            logger.streaming.info('Final content before end:', contentToStream.substring(0, 100));
            this.emit('streamEditContent', contentToStream);
          }

          logger.streaming.info('🏁 STREAMING MODE ENDED');
          this.emit('streamEditEnd', {});
          this.isStreamingEdit = false;
          this.streamingConfig = null;
          this.accumulatedContent = '';
          this.streamStartDetected = false;
          this.streamBuffer = '';
        } else {
          // Check if buffer ends with partial marker that might continue
          const partialMarkers = ['<!--', '<!-- S', '<!-- ST', '<!-- STR', '<!-- STRE', '<!-- STREA', '<!-- STREAM', '<!-- STREAM_', '<!-- STREAM_E', '<!-- STREAM_EN', '<!-- STREAM_END'];
          let hasPartialMarker = false;

          for (const marker of partialMarkers) {
            if (this.streamBuffer.endsWith(marker)) {
              hasPartialMarker = true;
              break;
            }
          }

          // If no partial marker at the end, emit accumulated content and clear buffer
          if (!hasPartialMarker && this.streamBuffer.length > 0) {
            logger.streaming.info('Streaming content chunk:', this.streamBuffer.substring(0, 50));
            this.emit('streamEditContent', this.streamBuffer);
            this.streamBuffer = '';
          }
          // Otherwise keep accumulating until we have a complete marker or no partial
        }
        return;
      }

      // Reset accumulated content when message is complete
      if (data.isComplete) {
        // If we were still in streaming mode, end it with error
        if (this.isStreamingEdit) {
          logger.streaming.warn('⚠️ Stream ended unexpectedly without STREAM_END marker');

          // Emit any remaining buffer content
          if (this.streamBuffer.trim()) {
            this.emit('streamEditContent', this.streamBuffer);
          }

          this.emit('streamEditEnd', { error: 'Stream ended without proper closing marker' });
          this.isStreamingEdit = false;
          this.streamingConfig = null;
          this.streamBuffer = '';
        }

        this.accumulatedContent = '';
        this.streamStartDetected = false;
      }

      // Normal streaming response
      if (data.isComplete) {
        if (data.content) {
          // logger.api.info('AI final response', {
          //   length: data.content.length,
          //   preview: previewForLog(data.content)
          // });
        } else {
          logger.api.info('AI final response had no text content');
        }
        if (Array.isArray(data.edits) && data.edits.length > 0) {
          // logger.api.info('AI final edits summary', {
          //   editCount: data.edits.length,
          //   replacementCounts: data.edits.map((edit: any) => Array.isArray(edit?.replacements) ? edit.replacements.length : 0)
          // });
        }
      }
      if (data.toolError) {
        logger.api.warn('AI reported tool error', {
          name: data.toolError.name,
          error: data.toolError.error
        });
      }
      // logger.api.info('Normal (non-streaming) response');
      this.emit('streamResponse', data);
    };

    // Listen for stream response events
    window.electronAPI.onAIStreamResponse(handleStreamResponse);

    // Listen for edit requests
    window.electronAPI.onAIEditRequest((edit: EditRequest) => {
      this.emit('editRequest', edit);
    });

    // Listen for new AI applyDiff events
    window.electronAPI.onAIApplyDiff(async (data: { replacements: any[], resultChannel: string, targetFilePath?: string }) => {
      try {
        const replacementCount = Array.isArray(data?.replacements) ? data.replacements.length : undefined;
        const payloadPreview = previewForLog(JSON.stringify(data));
        logger.api.info('Renderer received applyDiff request', {
          replacements: replacementCount,
          targetFilePath: data.targetFilePath,
          preview: payloadPreview
        });
        if (replacementCount === undefined || replacementCount === 0) {
          logger.api.warn('applyDiff payload missing replacements');
        }

        // CRITICAL: Require explicit targetFilePath to prevent race conditions
        // The targetFilePath was captured when the message was sent and must be provided.
        // Using the active editor as fallback is DANGEROUS because the user may have
        // switched tabs while waiting for the AI response.
        const targetFilePath = data.targetFilePath;

        if (!targetFilePath) {
          logger.api.error('CRITICAL: applyDiff called without targetFilePath - this is a bug that could apply edits to the wrong document');
          window.electronAPI.sendMcpApplyDiffResult(data.resultChannel, {
            success: false,
            error: 'No target file path provided - cannot safely apply diff (user may have switched tabs)'
          });
          return;
        }

        // Validate target: filesystem markdown files OR shared collab docs.
        const isCollab = isCollabUri(targetFilePath);
        if (!isCollab && !targetFilePath.endsWith('.md')) {
          window.electronAPI.sendMcpApplyDiffResult(data.resultChannel, {
            success: false,
            error: `applyDiff can only modify markdown files (.md) or collaborative documents (collab:// URIs). Attempted to modify: ${targetFilePath}`
          });
          return;
        }

        // If the file isn't registered (not open), open it in the background.
        // Collaborative docs cannot be opened in the background here — they
        // live in Yjs and require an active CollaborativeTabEditor mount.
        if (!editorRegistry.has(targetFilePath)) {
          if (isCollab) {
            window.electronAPI.sendMcpApplyDiffResult(data.resultChannel, {
              success: false,
              error: `Cannot edit collab document ${targetFilePath}: no editor is currently mounted for it. Open the document in collab mode first.`
            });
            return;
          }
          logger.api.info('File not open, opening in background:', targetFilePath);

          // Read the file content
          const result = await window.electronAPI.readFileContent(targetFilePath);
          const fileContent = result?.success ? result.content : '';

          // Open the file using editorRegistry's file opener
          await editorRegistry.openFileInBackground(targetFilePath, fileContent);
        }

        const result = await editorRegistry.applyReplacements(targetFilePath, data.replacements);
        logger.api.info('Renderer applyDiff result', result);
        // Send result back through the result channel
        window.electronAPI.sendMcpApplyDiffResult(data.resultChannel, result);
      } catch (error) {
        console.error('Failed to apply diff:', error);
        window.electronAPI.sendMcpApplyDiffResult(data.resultChannel, {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to apply diff'
        });
      }
    });
  }

  // Provider management (deprecated - provider should be specified explicitly)
  setDefaultProvider(_provider: 'claude' | 'claude-code' | 'openai') {
    // No-op - defaultProvider has been removed
    console.warn('setDefaultProvider is deprecated - provider should be specified explicitly');
  }

  getDefaultProvider(): 'claude' | 'claude-code' | 'openai' {
    // Return claude-code as default for backward compatibility
    return 'claude-code';
  }

  // Initialize with optional provider selection
  async initialize(apiKey?: string, provider?: 'claude' | 'claude-code' | 'openai'): Promise<{ success: boolean }> {
    return window.electronAPI.aiInitialize(provider || 'claude-code', apiKey);
  }

  // Create session with provider and model selection
  async createSession(
    documentContext?: DocumentContext,
    workspacePath?: string,
    provider?: 'claude' | 'claude-code' | 'claude-code-cli' | 'openai' | 'lmstudio',
    modelId?: string,
    sessionType?: string
  ): Promise<SessionData> {
    // Provider must be explicitly specified, no default
    if (!provider) {
      throw new Error('Provider must be specified when creating a session');
    }
    return window.electronAPI.aiCreateSession(provider, documentContext, workspacePath, modelId, sessionType);
  }

  // New method specifically for creating session with provider
  async createSessionWithProvider(
    provider: 'claude' | 'claude-code' | 'claude-code-cli' | 'openai',
    documentContext?: DocumentContext,
    workspacePath?: string,
    modelId?: string,
    sessionType?: string
  ): Promise<SessionData> {
    return window.electronAPI.aiCreateSession(provider, documentContext, workspacePath, modelId, sessionType);
  }

  async sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    workspacePath?: string
  ): Promise<{ content: string; edits: EditRequest[] }> {
    return window.electronAPI.aiSendMessage(message, documentContext, sessionId, workspacePath);
  }

  async getSessions(workspacePath?: string): Promise<SessionData[]> {
    return window.electronAPI.aiGetSessions(workspacePath);
  }

  async loadSession(sessionId: string, workspacePath?: string): Promise<SessionData> {
    return window.electronAPI.aiLoadSession(sessionId, workspacePath);
  }

  async clearSession(): Promise<{ success: boolean }> {
    return window.electronAPI.aiClearSession();
  }

  async updateSessionMessages(sessionId: string, messages: any[], workspacePath?: string): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.aiUpdateSessionMessages(sessionId, messages, workspacePath);
  }

  async saveDraftInput(sessionId: string, draftInput: string, workspacePath?: string): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.aiSaveDraftInput(sessionId, draftInput, workspacePath);
  }

  async deleteSession(sessionId: string, workspacePath?: string): Promise<{ success: boolean }> {
    return window.electronAPI.aiDeleteSession(sessionId, workspacePath);
  }

  async cancelRequest(sessionId: string): Promise<{ success: boolean; error?: string }> {
    if (!sessionId) {
      console.error('[AIApi] cancelRequest called without sessionId');
      return { success: false, error: 'Session ID is required to cancel request' };
    }
    return window.electronAPI.aiCancelRequest(sessionId);
  }

  async applyEdit(edit: EditRequest, targetFilePath?: string): Promise<{ success: boolean; error?: string }> {
    // Apply diff edits via editor registry
    try {
      // If this is a diff edit with replacements, use the editor registry
      if (edit.type === 'diff' && 'replacements' in edit) {
        // SAFETY: Require explicit targetFilePath - no fallbacks allowed
        if (!targetFilePath) {
          return {
            success: false,
            error: 'applyEdit requires explicit targetFilePath parameter - no target file specified'
          };
        }

        const filePath = targetFilePath;

        logger.api.info('applyEdit via registry', {
          replacements: Array.isArray((edit as any).replacements) ? (edit as any).replacements.length : undefined,
          targetFilePath: filePath
        });

        const result = await editorRegistry.applyReplacements(filePath, (edit as any).replacements);
        logger.api.info('applyEdit result from registry', result);
        return result;
      }

      // For other edit types or if bridge not available, use the IPC method
      const result = await window.electronAPI.aiApplyEdit(edit);
      return { success: result.success, error: result.success ? undefined : 'Failed to apply edit' };
    } catch (error) {
      console.error('Failed to apply edit:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to apply edit'
      };
    }
  }

  // Event handling
  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: Function) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.delete(callback);
    }
  }

  private streamChunkCount = 0;
  private lastStreamLength = 0;

  private emit(event: string, data: any) {
    const callbacks = this.listeners.get(event);

    // More concise logging for streaming events
    if (event === 'streamResponse') {
      // Only log brief status for streaming, not the full content
      if (data.isComplete) {
        // logger.api.info(`✓ Stream complete (${this.streamChunkCount} chunks, ${this.lastStreamLength} chars)`);
        this.streamChunkCount = 0;
        this.lastStreamLength = 0;
      } else if (data.partial && !data.content) {
        // Track chunks and show progress
        this.streamChunkCount++;
        const partialLength = data.partial?.length || 0;
        const newChars = partialLength - this.lastStreamLength;
        this.lastStreamLength = partialLength;

        // Log every 5 chunks or every 200 new characters
        // if (this.streamChunkCount % 5 === 1 || newChars > 200) {
        //   logger.api.info(`📝 Chunk #${this.streamChunkCount}: +${newChars} chars (total: ${partialLength})`);
        // }
      }
    } else if (event === 'performanceMetrics') {
      // Show performance metrics concisely
      if (data.phase === 'start') {
        logger.api.info(`🚀 Stream starting: ${data.provider} ${data.model}`);
      } else if (data.phase === 'firstChunk') {
        logger.api.info(`⚡ First chunk: ${data.timeToFirstChunk}ms`);
      }
    } else {
      // Normal verbose logging for other events
      logger.api.info(`Emitting event '${event}' with ${callbacks?.size || 0} listeners`, data);
    }

    if (callbacks) {
      callbacks.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`[AIApi] Error in event handler for '${event}':`, error);
        }
      });
    }
  }

  // Settings management
  async getSettings(): Promise<{
    defaultProvider: 'claude' | 'claude-code';
    apiKeys: Record<string, string>;
    providerSettings: any;
  }> {
    return window.electronAPI.getAISettings();
  }

  async saveSettings(settings: {
    defaultProvider?: 'claude' | 'claude-code';
    apiKeys?: Record<string, string>;
    providerSettings?: any;
  }): Promise<{ success: boolean }> {
    await window.electronAPI.saveAISettings(settings);
    return { success: true };
  }

  // Test connection for a specific provider
  async testConnection(provider: 'claude' | 'claude-code'): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.testAIConnection(provider);
  }

  // Get available models
  async getModels(): Promise<{ success: boolean; models?: any[] }> {
    return window.electronAPI.getAIModels();
  }
}

export const aiApi = new AIApi();
export default aiApi;
export type { DocumentContext, EditRequest, Message, SessionData };
