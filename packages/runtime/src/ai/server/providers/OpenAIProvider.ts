/**
 * OpenAI provider using OpenAI SDK
 */

import OpenAI from 'openai';
import { BaseAIProvider } from '../AIProvider';
import fs from 'fs/promises';
import * as path from 'path';
import {
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
  Message,
  AIModel,
  ModelIdentifier,
  OpenAICompatibleProviderType
} from '../types';
import { OPENAI_MODELS, DEFAULT_MODELS } from '../../modelConstants';
import { buildUserMessageAddition } from './documentContextUtils';
import {
  filterOpenAICompatibleModelIds,
  isOpenAICompatibleModelAllowed,
} from '../openAICompatibleModelFilters';

export class OpenAIProvider extends BaseAIProvider {
  private openai: OpenAI | null = null;
  private abortController: AbortController | null = null;
  private providerId: OpenAICompatibleProviderType;

  static readonly DEFAULT_MODEL = DEFAULT_MODELS.openai;

  constructor(providerId: OpenAICompatibleProviderType = 'openai') {
    super();
    this.providerId = providerId;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    const initStartTime = Date.now();
    console.log(`[OpenAIProvider] Initializing with config:`, {
      hasApiKey: !!config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxTokens: config.maxTokens
    });

    this.config = config;

    if (!config.apiKey) {
      throw new Error('API key required for OpenAI provider');
    }

    // Use consistent timeout for all models
    const timeout = 90000; // 90 seconds
    console.log(`[OpenAIProvider] Creating OpenAI client with timeout: ${timeout}ms, maxRetries: 0`);
    this.openai = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout,
      maxRetries: 0,  // NO RETRIES - fail fast
      dangerouslyAllowBrowser: false  // We're in Node.js/Electron main process
    });

    if (!this.config.model || this.config.model.endsWith(':local-model')) {
      const models = await OpenAIProvider.getModels(config.apiKey, config.baseUrl, this.providerId, config.modelFilterRegex);
      const firstModel = models[0]?.id;
      if (firstModel) {
        this.config.model = firstModel;
      }
    }

    if (this.config.model && !isOpenAICompatibleModelAllowed(this.providerId, this.config.model, this.config.modelFilterRegex)) {
      throw new Error(`Model ${this.config.model} is not allowed for provider ${this.providerId}`);
    }

    console.log(`[OpenAIProvider] OpenAI client created`);
    console.log(`[OpenAIProvider] Initialized in ${Date.now() - initStartTime}ms`);
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: Message[],
    workspacePath?: string,
    attachments?: any[]
  ): AsyncIterableIterator<StreamChunk> {
    const startTime = Date.now();
    console.log(`[OpenAIProvider] Starting sendMessage - message length: ${message.length}, hasContext: ${!!documentContext}, contextMessages: ${messages?.length || 0}`);

    if (!this.openai) {
      throw new Error('OpenAI provider not initialized');
    }

    // Build system prompt (no longer includes document context - that's in user message now)
    const promptStartTime = Date.now();
    const systemPrompt = this.buildSystemPrompt(documentContext);
    console.log(`[OpenAIProvider] System prompt built in ${Date.now() - promptStartTime}ms, length: ${systemPrompt.length}`);

    // Append document context to message using pre-built prompts from DocumentContextService
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);
    message = messageWithContext;

    // Emit prompt additions for debugging UI
    const hasAttachments = attachments && attachments.length > 0;
    if (sessionId && (systemPrompt || userMessageAddition || hasAttachments)) {
      // Build attachment summaries (don't include full base64 data, just metadata)
      const attachmentSummaries = attachments?.map(att => ({
        type: att.type,
        filename: att.filename || (att.filepath ? path.basename(att.filepath) : 'unknown'),
        mimeType: att.mimeType,
        filepath: att.filepath
      })) || [];

      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition: userMessageAddition,
        attachments: attachmentSummaries,
        timestamp: Date.now()
      });
    }

    // Create abort controller for this request
    this.abortController = new AbortController();

    // Build messages array for OpenAI API
    const apiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt }
    ];

    // Add existing messages if provided
    if (messages && messages.length > 0) {
      console.log(`[OpenAIProvider] Processing ${messages.length} context messages`);
      for (const msg of messages) {
        // Skip messages with empty content
        if (!msg.content || msg.content.trim() === '') {
          console.warn('[OpenAIProvider] Skipping message with empty content:', msg);
          continue;
        }

        // Convert tool messages to assistant messages for OpenAI
        if (msg.role === 'tool') {
          continue; // Skip tool messages for now
        }

        // Check if message has attachments (images)
        if (msg.attachments && msg.attachments.length > 0) {
          // Build content array with images and text
          const content: OpenAI.Chat.ChatCompletionContentPart[] = [];

          // Add images first
          for (const attachment of msg.attachments) {
            if (attachment.type === 'image') {
              try {
                const fileBuffer = await fs.readFile(attachment.filepath);
                const base64Data = fileBuffer.toString('base64');

                content.push({
                  type: 'image_url',
                  image_url: {
                    url: `data:${attachment.mimeType};base64,${base64Data}`
                  }
                });
              } catch (error) {
                console.error('[OpenAIProvider] Failed to read attachment:', error);
              }
            }
          }

          // Add text content
          content.push({
            type: 'text',
            text: msg.content
          });

          if (msg.role === 'user') {
            apiMessages.push({
              role: 'user' as const,
              content
            });
          } else {
            // For assistant messages with images, we need to convert to text-only
            apiMessages.push({
              role: 'assistant' as const,
              content: msg.content
            });
          }
        } else {
          // No attachments, use simple text content
          apiMessages.push({
            role: msg.role === 'user' ? 'user' : 'assistant',
            content: msg.content
          });
        }
      }
    }

    // Add the new user message (check for attachments)
    if (!message || message.trim() === '') {
      throw new Error('Cannot send empty message to OpenAI API');
    }

    // Check if current message has attachments (images)
    if (attachments && attachments.length > 0) {
      const content: OpenAI.Chat.ChatCompletionContentPart[] = [];

      // Add images first
      for (const attachment of attachments) {
        if (attachment.type === 'image') {
          try {
            const fileBuffer = await fs.readFile(attachment.filepath);
            const base64Data = fileBuffer.toString('base64');

            content.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${base64Data}`
              }
            });
          } catch (error) {
            console.error('[OpenAIProvider] Failed to read attachment:', error);
          }
        }
      }

      // Add text content
      content.push({
        type: 'text',
        text: message
      });

      apiMessages.push({ role: 'user', content });
    } else {
      // No attachments, use simple text content
      apiMessages.push({ role: 'user', content: message });
    }

    // Log the input message
    // CRITICAL: Must await to ensure user message is persisted before proceeding
    if (sessionId) {
      await this.logAgentMessage(sessionId, this.providerId, 'input', message);
    }

    try {
      // Use the centralized tool system
      const tools: OpenAI.Chat.ChatCompletionTool[] = this.getToolsInOpenAIFormat();
      console.log(`[OpenAIProvider] Available tools for OpenAI:`, tools.map(t => t.function?.name || 'unknown'));
      if (tools.length === 0) {
        console.warn('[OpenAIProvider] WARNING: No tools available! Check tool registration.');
      }

      if (!this.config.model) {
        throw new Error('No model specified for OpenAI provider');
      }

      // Remove provider prefix from model ID for API call
      const modelId = this.config.model.replace(`${this.providerId}:`, '');
      if (!isOpenAICompatibleModelAllowed(this.providerId, modelId, this.config.modelFilterRegex)) {
        throw new Error(`Model ${modelId} is not allowed for provider ${this.providerId}`);
      }
      console.log(`[OpenAIProvider] Using model: ${modelId}`);

      const completionParams: any = {
        model: modelId,
        messages: apiMessages,
        tools,
        tool_choice: tools.length > 0 ? 'auto' : undefined,  // Only set if we have tools
        stream: true,
        stream_options: { include_usage: true }  // Request usage data in streaming response
      };

      // Apply response format if specified (extension chat completions)
      if (this.config.responseFormat && this.config.responseFormat.type !== 'text') {
        if (this.config.responseFormat.type === 'json_object') {
          completionParams.response_format = { type: 'json_object' };
        } else if (this.config.responseFormat.type === 'json_schema' && this.config.responseFormat.schema) {
          completionParams.response_format = {
            type: 'json_schema',
            json_schema: {
              name: this.config.responseFormat.name || 'response',
              schema: this.config.responseFormat.schema,
              strict: this.config.responseFormat.strict ?? true,
            },
          };
        }
      }

      // Some models (o1 series, gpt-5, gpt-4.5) don't support temperature parameter
      // They only work with the default temperature of 1
      const supportsTemperature =
        !modelId.startsWith('o1') &&
        !modelId.startsWith('gpt-5') &&
        !modelId.startsWith('gpt-4.5');
      if (supportsTemperature) {
        completionParams.temperature = this.config.temperature || 0;
      }

      // All recent models use max_completion_tokens
      // Only legacy models (gpt-3.5-turbo, gpt-4-turbo) use max_tokens
      const usesLegacyMaxTokens =
        modelId.startsWith('gpt-3.5') ||
        modelId === 'gpt-4-turbo' ||
        modelId === 'gpt-4-turbo-preview';

      if (usesLegacyMaxTokens) {
        completionParams.max_tokens = this.config.maxTokens || 4000;
      } else {
        // All other models (gpt-4o, gpt-4.5, gpt-5, o1, etc.) use max_completion_tokens
        completionParams.max_completion_tokens = this.config.maxTokens || 4000;
      }

      console.log(`[OpenAIProvider] Calling OpenAI API with ${apiMessages.length} messages`);
      console.log(`[OpenAIProvider] Request params:`, {
        model: completionParams.model,
        messageCount: completionParams.messages.length,
        temperature: completionParams.temperature,
        max_tokens: completionParams.max_tokens,
        max_completion_tokens: completionParams.max_completion_tokens,
        tools: completionParams.tools?.length,
        stream: completionParams.stream
      });
      // console.log(`[OpenAIProvider] Actual completionParams keys:`, Object.keys(completionParams));

      const apiCallStartTime = Date.now();

      let response;
      try {
        response = await this.openai.chat.completions.create(completionParams, {
          signal: this.abortController.signal
        });
      } catch (error: any) {
        console.error(`[OpenAIProvider] completions.create failed after ${Date.now() - apiCallStartTime}ms:`, error);
        console.error(`[OpenAIProvider] Error details:`, {
          name: error.name,
          message: error.message,
          status: error.status,
          code: error.code,
          type: error.type
        });
        throw error;
      }
      let fullContent = '';
      let currentToolCall: any = null;
      let toolCallAccumulator: any = {};
      let chunkCount = 0;
      let firstChunkTime: number | undefined;
      let toolCallCount = 0;
      let usageData: any = null;

      const iteratorStartTime = Date.now();

      // Add a timeout check
      const timeoutCheck = setTimeout(() => {
        if (!firstChunkTime) {
          console.warn(`[OpenAIProvider] WARNING: No chunks received after 5 seconds of iteration`);
        }
      }, 5000);

      const responseStream = response as unknown as AsyncIterable<any>;
      for await (const chunk of responseStream) {
        if (chunkCount === 0) {
          firstChunkTime = Date.now();
          clearTimeout(timeoutCheck);
        }
        chunkCount++;

        // Check for error in the chunk (some providers send errors in the stream)
        if ((chunk as any).error) {
          const errorMessage = (chunk as any).error.message || (chunk as any).error.type || JSON.stringify((chunk as any).error);
          console.error('[OpenAIProvider] Error in streaming response:', errorMessage);

          // Log error to database
          this.logError(sessionId, this.providerId, new Error(errorMessage), 'streaming_response');

          yield {
            type: 'error',
            error: errorMessage
          };
          return;
        }

        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          // Text chunk
          fullContent += delta.content;
          // console.log(`[OpenAIProvider] Text chunk #${chunkCount}: "${delta.content.substring(0, 50)}..." (${delta.content.length} chars)`);
          yield {
            type: 'text',
            content: delta.content
          };
        }

        if (delta?.tool_calls) {
          // Handle tool calls
          for (const toolCall of delta.tool_calls) {
            const callId = toolCall.index || 0;

            if (!toolCallAccumulator[callId]) {
              toolCallAccumulator[callId] = {
                id: toolCall.id || `call_${callId}`,
                type: 'function',
                function: {
                  name: toolCall.function?.name || '',
                  arguments: ''
                }
              };
            }

            if (toolCall.function?.name) {
              toolCallAccumulator[callId].function.name = toolCall.function.name;
            }

            if (toolCall.function?.arguments) {
              toolCallAccumulator[callId].function.arguments += toolCall.function.arguments;
            }
          }
        }

        if (chunk.choices[0]?.finish_reason === 'tool_calls') {
          // Process accumulated tool calls
          for (const callId in toolCallAccumulator) {
            const toolCall = toolCallAccumulator[callId];
            toolCallCount++;
            const toolId = toolCall.id || `tool-${toolCallCount}`;
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const toolName = toolCall.function.name;
              console.log(`[OpenAIProvider] Tool call #${toolCallCount}: ${toolName}`);

              let executionResult: any | undefined;
              let executionError: string | undefined;

              // Handle streamContent specially - it streams directly to editor
              if (toolName === 'streamContent') {
                const position = args.position || 'cursor';
                const insertAtEnd = position === 'end' || position === 'end of document';

                yield {
                  type: 'stream_edit_start',
                  config: {
                    position,
                    insertAfter: args.insertAfter,
                    insertAtEnd,
                    mode: undefined
                  }
                };

                if (args.content) {
                  yield {
                    type: 'stream_edit_content',
                    content: args.content
                  };
                }

                yield {
                  type: 'stream_edit_end'
                };

                // Mark as successful execution
                executionResult = { success: true, message: 'Content streamed to editor' };
              } else {
                // Execute other tools via tool handler
                if (this.toolHandler) {
                  const toolStartTime = Date.now();
                  try {
                    executionResult = await this.executeToolCall(toolName, args);
                    console.log(`[OpenAIProvider] ${toolName} execution completed in ${Date.now() - toolStartTime}ms`);
                    if (executionResult !== undefined) {
                      try {
                        console.log(`[OpenAIProvider] ${toolName} result:`, JSON.stringify(executionResult, null, 2));
                      } catch (stringifyError) {
                        console.log(`[OpenAIProvider] ${toolName} result could not be stringified`, stringifyError);
                      }
                    }
                  } catch (error) {
                    executionError = error instanceof Error ? error.message : 'Tool execution failed';
                    const errorResult = (error as any)?.toolResult ?? { success: false, error: executionError };
                    executionResult = errorResult;
                    console.error(`[OpenAIProvider] ${toolName} execution failed:`, error);
                    yield {
                      type: 'tool_error',
                      toolError: {
                        name: toolName,
                        arguments: args,
                        error: executionError,
                        result: errorResult
                      }
                    };
                  }
                } else {
                  console.warn(`[OpenAIProvider] No tool handler registered - skipping execution for ${toolName}`);
                }
              }

              // Log tool call to database in format that UI can reconstruct
              if (sessionId) {
                // Log the tool_use block
                this.logAgentMessage(sessionId, this.providerId, 'output', JSON.stringify({
                  type: 'assistant',
                  message: {
                    content: [{
                      type: 'tool_use',
                      id: toolId,
                      name: toolName,
                      input: args
                    }]
                  }
                }));

                // Log the tool_result block
                const resultContent = executionResult !== undefined
                  ? (typeof executionResult === 'string' ? executionResult : JSON.stringify(executionResult))
                  : 'Tool executed';
                this.logAgentMessage(sessionId, this.providerId, 'output', JSON.stringify({
                  type: 'assistant',
                  message: {
                    content: [{
                      type: 'tool_result',
                      tool_use_id: toolId,
                      content: resultContent,
                      is_error: executionError !== undefined
                    }]
                  }
                }));
              }

              // Yield tool_call event so AIService can track it
              yield {
                type: 'tool_call',
                toolCall: {
                  id: toolId,
                  name: toolName,
                  arguments: args,
                  ...(executionResult !== undefined ? { result: executionResult } : {})
                }
              };
            } catch (error) {
              console.error(`[OpenAIProvider] Error parsing tool arguments for call ${callId}:`, error);
            }
          }
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          if (finishReason === 'stop') {
            // Message complete
            // console.log(`[OpenAIProvider] Stream complete - Total time: ${Date.now() - startTime}ms, Chunks: ${chunkCount}, Content length: ${fullContent.length}`);
          } else if (finishReason !== 'tool_calls') {
            console.warn(`[OpenAIProvider] Unexpected finish_reason: ${finishReason}`);
          }
        }

        // Check for usage data in the chunk (OpenAI includes it in the final chunk)
        if (chunk.usage) {
          usageData = chunk.usage;
        }

        // Check if this is the last chunk with usage
        if (chunk.x_groq && chunk.x_groq.usage) {
          // Some providers send usage in x_groq
          usageData = chunk.x_groq.usage;
        }
      }

      // Log the text output message if there was any text content
      // Note: Tool calls are logged individually above, so we only log text here
      if (sessionId && fullContent) {
        await this.logAgentMessage(sessionId, this.providerId, 'output', fullContent, {
          usage: usageData
        });
      }

      // Yield complete AFTER any final message is saved to database
      yield {
        type: 'complete',
        content: fullContent,
        isComplete: true,
        ...(usageData ? {
          usage: {
            input_tokens: usageData.prompt_tokens || usageData.input_tokens || 0,
            output_tokens: usageData.completion_tokens || usageData.output_tokens || 0,
            total_tokens: usageData.total_tokens || ((usageData.prompt_tokens || 0) + (usageData.completion_tokens || 0))
          }
        } : {})
      };

    } catch (error: any) {
      const errorTime = Date.now() - startTime;
      if (error.name === 'AbortError') {
        console.log(`[OpenAIProvider] Request was aborted after ${errorTime}ms`);
        yield {
          type: 'complete',
          isComplete: true
        };
      } else {
        console.error(`[OpenAIProvider] Error after ${errorTime}ms:`, error);

        // Log error to database
        this.logError(sessionId, this.providerId, error, 'catch_block');

        yield {
          type: 'error',
          error: error.message
        };
      }
    } finally {
      this.abortController = null;
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      mcpSupport: false,
      edits: true,
      resumeSession: false,
      supportsFileTools: false  // Files should be attached to messages, not accessed via tools
    };
  }

  destroy(): void {
    this.abort();
    this.openai = null;
  }

  protected buildSystemPrompt(documentContext?: DocumentContext): string {
    // The base prompt now includes all tool usage instructions
    return super.buildSystemPrompt(documentContext);
  }

  /**
   * Get available OpenAI models (filtered from API response)
   */
  static async getModels(apiKey?: string, baseUrl?: string, provider: OpenAICompatibleProviderType = 'openai', modelFilterRegex?: string): Promise<AIModel[]> {
    if (!apiKey) return this.getDefaultModels();

    try {
      // console.log('[OpenAIProvider] Fetching available models from OpenAI API');
      const modelFetchStart = Date.now();
      const openai = new OpenAI({ apiKey, baseURL: baseUrl });
      const response = await openai.models.list();
      // console.log(`[OpenAIProvider] Fetched ${response.data.length} models in ${Date.now() - modelFetchStart}ms`);

      if (baseUrl || provider !== 'openai') {
        const modelIds = filterOpenAICompatibleModelIds(
          provider,
          response.data.map((model) => model.id),
          modelFilterRegex,
        );
        return modelIds.map((modelId) => ({
          id: ModelIdentifier.create(provider, modelId).combined,
          name: modelId,
          provider,
          maxTokens: 0,
          contextWindow: 0
        }));
      }

      // Filter to only allowed models
      const availableIds = new Set(response.data.map(m => m.id));
      const filtered: AIModel[] = [];

      for (const model of OPENAI_MODELS) {
        if (availableIds.has(model.id)) {
          filtered.push({
            id: ModelIdentifier.create(provider, model.id).combined,
            name: model.displayName,
            provider,
            maxTokens: model.maxTokens,
            contextWindow: model.contextWindow
          });
        }
      }

      // console.log(`[OpenAIProvider] Filtered to ${filtered.length} allowed models`);
      return filtered.length > 0 ? filtered : [];
    } catch (error) {
      console.error('[OpenAIProvider] Failed to fetch models:', error);
      return [];
    }
  }

  /**
   * Get default models
   */
  static getDefaultModels(): AIModel[] {
    return OPENAI_MODELS.map(model => ({
      id: ModelIdentifier.create('openai', model.id).combined,
      name: model.displayName,
      provider: 'openai' as const,
      maxTokens: model.maxTokens,
      contextWindow: model.contextWindow
    }));
  }

  /**
   * Get default model
   */
  static getDefaultModel(): string {
    return this.DEFAULT_MODEL;
  }

  /**
   * Check if a model is allowed
   */
  static isModelAllowed(modelId: string): boolean {
    // Try parsing with ModelIdentifier to extract the model part
    const parsed = ModelIdentifier.tryParse(modelId);
    const cleanId = parsed ? parsed.model : modelId;
    // Check if it's in our allowed list
    return OPENAI_MODELS.some(m => m.id === cleanId) ||
           cleanId.startsWith('gpt-5') ||
           cleanId.startsWith('gpt-4');
  }
}
