/**
 * Synthetic.new provider for Nimbalyst
 *
 * Synthetic.new is a hosted inference API exposing open-weight models
 * (Llama, Qwen, DeepSeek, Kimi, GLM, etc.) via an OpenAI-compatible chat completions API.
 *
 * Architecture: LMStudioProvider's streaming/tool-call machinery + OpenAIProvider's auth requirement.
 * Wire format: OpenAI-compatible (same as LMStudio) but with Bearer auth (unlike local LMStudio).
 */

import { BaseAIProvider } from '../AIProvider';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
  AIModel,
  ModelIdentifier
} from '../types';
import { buildUserMessageAddition } from './documentContextUtils';

export interface SyntheticConfig extends ProviderConfig {
  baseUrl?: string;
}

export class SyntheticProvider extends BaseAIProvider {
  private baseUrl: string = 'https://api.synthetic.new/openai/v1';
  private abortController: AbortController | null = null;

  static readonly DEFAULT_BASE_URL = 'https://api.synthetic.new/openai/v1';
  static readonly DEFAULT_MODEL = 'syn:coding';

  async initialize(config: SyntheticConfig): Promise<void> {
    this.config = config;
    this.baseUrl = config.baseUrl || SyntheticProvider.DEFAULT_BASE_URL;

    // Require API key for Synthetic.new (unlike local LMStudio)
    if (!config.apiKey) {
      throw new Error('API key is required for Synthetic.new provider');
    }
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: any[]
  ): AsyncIterableIterator<StreamChunk> {
    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(documentContext);

    // Append document context to message using pre-built prompts from DocumentContextService
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);
    message = messageWithContext;

    // Emit prompt additions for debugging UI
    const hasAttachments = attachments && attachments.length > 0;
    if (sessionId && (systemPrompt || userMessageAddition || hasAttachments)) {
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

    // Create abort controller
    this.abortController = new AbortController();

    // Build messages array for OpenAI-compatible API
    const apiMessages: any[] = [
      { role: 'system', content: systemPrompt }
    ];

    // Add existing messages if provided
    if (messages && messages.length > 0) {
      for (const msg of messages) {
        if (!msg.content || msg.content.trim() === '') continue;

        if (msg.role === 'tool') {
          apiMessages.push({
            role: 'tool',
            tool_call_id: msg.toolCall?.id || `tool_${Date.now()}`,
            content: msg.content || JSON.stringify(msg.toolCall?.result || {})
          });
        } else {
          // Check if message has attachments (images)
          if (msg.attachments && msg.attachments.length > 0) {
            const content: any[] = [];

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
                  console.error('[SyntheticProvider] Failed to read attachment:', error);
                }
              }
            }

            // Add text content
            content.push({
              type: 'text',
              text: msg.content
            });

            apiMessages.push({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content
            });
          } else {
            // No attachments, use simple text content
            apiMessages.push({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content
            });
          }
        }
      }
    }

    // Add the new user message
    if (!message || message.trim() === '') {
      throw new Error('Cannot send empty message to Synthetic.new');
    }

    // Check if current message has attachments (images)
    if (attachments && attachments.length > 0) {
      const content: any[] = [];

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
            console.error('[SyntheticProvider] Failed to read attachment:', error);
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
    if (sessionId) {
      await this.logAgentMessage(sessionId, 'synthetic', 'input', message);
    }

    // Use the centralized tool system (OpenAI-compatible format)
    const tools = this.getToolsInOpenAIFormat();

    const requestBody: any = {
      model: this.config.model || SyntheticProvider.DEFAULT_MODEL,
      messages: apiMessages,
      max_tokens: this.config.maxTokens || 4096,
      temperature: this.config.temperature || 0.7,
      tools: tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true }
    };

    // Apply response format if specified
    if (this.config.responseFormat && this.config.responseFormat.type !== 'text') {
      if (this.config.responseFormat.type === 'json_object') {
        requestBody.response_format = { type: 'json_object' };
      } else if (this.config.responseFormat.type === 'json_schema' && this.config.responseFormat.schema) {
        requestBody.response_format = {
          type: 'json_schema',
          json_schema: {
            name: this.config.responseFormat.name || 'response',
            schema: this.config.responseFormat.schema,
            strict: this.config.responseFormat.strict ?? true,
          },
        };
      }
    }

    try {
      // Make streaming request to Synthetic.new
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: this.abortController.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Synthetic.new returned ${response.status}: ${response.statusText}`;
        if (errorText) errorMessage += ` - ${errorText}`;
        throw new Error(errorMessage);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body from Synthetic.new');
      }

      const decoder = new TextDecoder();
      let fullContent = '';
      let buffer = '';
      let currentToolCall: any = null;
      let chunkCount = 0;
      let usageData: { input_tokens?: number; output_tokens?: number } | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.trim() === 'data: [DONE]') {
            // Emit the final completion chunk
            yield {
              type: 'complete',
              content: fullContent,
              isComplete: true,
              usage: usageData ? {
                input_tokens: usageData.input_tokens || 0,
                output_tokens: usageData.output_tokens || 0,
                total_tokens: (usageData.input_tokens || 0) + (usageData.output_tokens || 0)
              } : undefined
            };

            // Log the output message
            if (sessionId) {
              await this.logAgentMessage(sessionId, 'synthetic', 'output', fullContent);
            }

            chunkCount++;
            currentToolCall = null;
            continue;
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const json = JSON.parse(data);
              const delta = json.choices?.[0]?.delta;

              // Extract usage from any delta
              if (json.usage) {
                usageData = {
                  input_tokens: json.usage.prompt_tokens,
                  output_tokens: json.usage.completion_tokens
                };
              }

              if (delta?.content) {
                // Standard content delta
                fullContent += delta.content;
                chunkCount++;

                yield {
                  type: 'text',
                  content: delta.content
                };
              }

              // Handle tool calls (function calling)
              if (delta?.tool_calls) {
                for (const toolCall of delta.tool_calls) {
                  if (!currentToolCall || currentToolCall.id !== toolCall.id) {
                    if (currentToolCall) {
                      // Emit the previous tool call
                      yield {
                        type: 'tool_call',
                        toolCall: {
                          id: currentToolCall.id,
                          name: currentToolCall.name,
                          arguments: currentToolCall.arguments ? JSON.parse(currentToolCall.arguments) : undefined,
                        }
                      };
                    }
                    currentToolCall = {
                      id: toolCall.id,
                      name: toolCall.function.name,
                      arguments: '',
                    };
                  }
                  currentToolCall.arguments += toolCall.function.arguments || '';
                }
              }

            } catch (jsonError) {
              console.warn('[SyntheticProvider] Failed to parse SSE data:', data, jsonError);
            }
          }
        }
      }

      // Emit any remaining tool call
      if (currentToolCall) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: currentToolCall.id,
            name: currentToolCall.name,
            arguments: currentToolCall.arguments ? JSON.parse(currentToolCall.arguments) : undefined,
          }
        };
      }

    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw error;
      }
      throw new Error(`Failed to communicate with Synthetic.new: ${error.message}`);
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  destroy(): void {
    this.abort();
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: true,
      mcpSupport: false,
      edits: true,
      resumeSession: false,
      supportsFileTools: false
    };
  }

  protected buildSystemPrompt(documentContext?: DocumentContext): string {
    let prompt = 'You are an AI assistant integrated with Nimbalyst editor.\n';
    prompt += 'You can help with code editing, reviewing, testing, and other coding tasks.\n\n';
    prompt += 'IMPORTANT: If you\'re asked to make code changes, never write an empty change. Always provide a minimal, complete change that addresses the request.\n';
    return prompt;
  }

  /**
   * Get available models from Synthetic.new API
   */
  static async getModels(apiKey: string, baseUrl: string = SyntheticProvider.DEFAULT_BASE_URL): Promise<AIModel[]> {
    if (!apiKey) return this.getDefaultModels();

    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!response.ok) {
        console.error('[SyntheticProvider] Failed to fetch models:', response.status);
        return this.getDefaultModels();
      }

      const data = await response.json();

      // Map Synthetic.new models to our format
      return data.data.map((model: any) => ({
        id: ModelIdentifier.create('synthetic', model.id).combined,
        name: this.formatModelName(model.id),
        provider: 'synthetic' as const,
        maxTokens: model.max_tokens || model.max_completion_tokens || 4096,
        contextWindow: model.context_length || 4096
      }));

    } catch (error) {
      console.error('[SyntheticProvider] Failed to fetch models:', error);
      return this.getDefaultModels();
    }
  }

  /**
   * Get default models
   */
  static getDefaultModels(): AIModel[] {
    return [
      {
        id: ModelIdentifier.create('synthetic', 'syn:coding').combined,
        name: 'Synthetic Coding',
        provider: 'synthetic' as const,
        maxTokens: 8192,
        contextWindow: 32768
      },
      {
        id: ModelIdentifier.create('synthetic', 'hf:Qwen/Qwen3.6-72B-Instruct').combined,
        name: 'Qwen 3.6 72B Instruct',
        provider: 'synthetic' as const,
        maxTokens: 32768,
        contextWindow: 131072
      },
      {
        id: ModelIdentifier.create('synthetic', 'hf:meta-llama/Meta-Llama-3.1-405B-Instruct').combined,
        name: 'Meta Llama 3.1 405B Instruct',
        provider: 'synthetic' as const,
        maxTokens: 16384,
        contextWindow: 131072
      }
    ];
  }

  /**
   * Get default model
   */
  static getDefaultModel(): string {
    return ModelIdentifier.create('synthetic', SyntheticProvider.DEFAULT_MODEL).combined;
  }

  private static formatModelName(modelId: string): string {
    // Clean up the model ID for display
    let cleaned = modelId;

    // Handle Synthetic.new category aliases (syn:coding → Synthetic Coding)
    if (cleaned.startsWith('syn:')) {
      const category = cleaned.slice(4);
      // Replace hyphens with spaces and capitalize each word
      const formatted = category
        .replace(/[_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, l => l.toUpperCase());
      return `Synthetic ${formatted}`;
    }

    // Remove provider prefix (hf:, etc.)
    cleaned = cleaned.replace(/^[a-z]+:/, '');

    // Handle duplicate org prefix: Qwen/Qwen3.6-72B-Instruct → Qwen 3.6 72B Instruct
    // by keeping the org prefix but removing the duplicate from the model name
    const slashIndex = cleaned.indexOf('/');
    if (slashIndex > 0) {
      const org = cleaned.slice(0, slashIndex);
      const model = cleaned.slice(slashIndex + 1);
      if (model.toLowerCase().startsWith(org.toLowerCase())) {
        // Model name starts with the org name (e.g. Qwen/Qwen3.6-72B-Instruct)
        // Keep the org prefix once and remove the duplicate from the model name
        cleaned = `${org} ${model.slice(org.length).replace(/^[-_]/, '')}`;
      } else {
        // Keep both parts separated by space
        cleaned = `${org} ${model}`;
      }
    }

    // Replace separators with spaces and capitalize (keep dots for version numbers)
    return cleaned
      .replace(/[_-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, l => l.toUpperCase());
  }
}
