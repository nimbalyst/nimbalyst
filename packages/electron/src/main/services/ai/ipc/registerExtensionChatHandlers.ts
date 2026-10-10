import { getProviderCredentials } from '../../credentials/providerCredentials';
import { findOwnedBackendTool } from '../../../mcp/backendToolRegistry';
import { resolveBackendWorkspacePath } from '../../../mcp/mcpWorkspaceResolver';
import { handleBackendTool } from '../../../mcp/tools/backendToolHandler';
import { safeHandle } from '../../../utils/ipcRegistry';
import { getWindowId } from '../../../window/WindowManager';
import { resolveSenderWorkspacePath } from '../../../window/captureWindowWorkspace';
import { resolveActiveWorkspacePathForWindowId } from '../../../window/windowState';
import { extensionPromptRequiresConfiguredApiKey, extractModelForProvider, safeSend } from '.././aiServiceUtils';
import { getLocalHostDeviceId, stampSessionHost } from '.././sessionHostAttribution';
import { type AIServiceContext } from './AIServiceContext';
import { AIProvider, ModelRegistry, ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { type AIProviderType, type Message, ModelIdentifier, type ProviderConfig } from '@nimbalyst/runtime/ai/server/types';
import { BrowserWindow } from 'electron';

/**
 * The extension SDK's AI surface: prompt dispatch, backend tool calls, model
 * listing, and chat completions (buffered and streaming).
 *
 * The three helpers below the registrar were private methods on AIService that
 * only these handlers used.
 */
export function registerExtensionChatHandlers(ctx: AIServiceContext): void {
  // Extension SDK: Send a prompt and wait for the full response
  safeHandle('extensions:ai-send-prompt', async (
    event,
    options: { prompt: string; sessionName?: string; provider?: string; model?: string }
  ) => {
    const { prompt, sessionName } = options;
    const provider = (options.provider || 'claude-code') as AIProviderType;
    if (!prompt) {
      throw new Error('prompt is required');
    }

    // Resolve the workspace from the window, honoring the project rail's
    // active selection. Reading the raw primary `workspacePath` would route
    // the new session to the startup project in Multi-Project mode (#544).
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const windowId = browserWindow ? getWindowId(browserWindow) : null;
    const workspacePath = resolveActiveWorkspacePathForWindowId(windowId);
    if (!workspacePath) {
      throw new Error('No workspace path available for extension AI prompt');
    }

    // Validate provider is enabled and has required credentials
    if (!ctx.isProviderEnabledForWorkspace(provider, workspacePath)) {
      throw new Error(`Provider ${provider} is not enabled for this workspace`);
    }

    // Direct API providers require explicitly configured keys. Agent providers
    // with their own sign-in flows (Claude Code and OpenAI Codex) do not.
    if (extensionPromptRequiresConfiguredApiKey(provider)) {
      const apiKey = ctx.getApiKeyForProvider(provider, workspacePath);
      if (!apiKey) {
        throw new Error(`API key not configured for provider ${provider}. Configure it in Settings > AI.`);
      }
    }

    // Use explicitly requested model, or fall back to provider default
    const model = options.model || await ModelRegistry.getDefaultModel(provider);
    const providerConfig: any = {
      maxTokens: ctx.getProviderSetting(provider, 'maxTokens'),
      temperature: ctx.getProviderSetting(provider, 'temperature'),
    };

    // For non-claude-code providers, set the model in provider config
    if (model && provider !== 'claude-code') {
      const modelForProvider = extractModelForProvider(model, provider);
      if (modelForProvider !== null) {
        providerConfig.model = modelForProvider;
      }
    }

    const session = await ctx.sessionManager.createSession(
      provider,
      undefined, // no document context
      workspacePath,
      providerConfig,
      model,
      'session',
    );
    await stampSessionHost(session.id, getLocalHostDeviceId());

    // Set session title
    if (sessionName) {
      await ctx.sessionManager.updateSessionTitle(session.id, sessionName, { force: true, markAsNamed: true });
    }

    // Notify renderer to refresh session list so the new session appears
    safeSend(event, 'sessions:refresh-list', { workspacePath, sessionId: session.id });

    // Send the prompt via the existing sendMessage handler
    if (!ctx.sendMessageHandler) {
      throw new Error('sendMessageHandler not initialized');
    }

    const result = await ctx.sendMessageHandler(event, prompt, undefined, session.id, workspacePath);
    const response = result?.content || '';

    return { sessionId: session.id, response };
  });

  // Extension SDK: renderer->backend READ bridge. Lets an extension's renderer
  // half (settings panel, voice context provider) call one of ITS OWN backend
  // module's MCP tools and get the parsed result. Tool calls otherwise route
  // main->backend with no renderer hop; this is the one path the renderer needs
  // for read access (live index status, listing facts, triggering a rebuild).
  //
  // SECURITY: `callerExtensionId` is injected by the host that builds the
  // bridge (ExtensionLoader / settings panel) from the extension's own
  // manifest id — it is NOT supplied by extension code. We enforce that the
  // resolved tool belongs to the calling extension so one enabled extension
  // can't reach into another extension's backend tools (e.g. memory.delete_fact)
  // just by knowing the name.
  safeHandle('extensions:ai-call-backend-tool', async (
    event,
    options: {
      toolName: string;
      args?: Record<string, unknown>;
      workspacePath?: string;
      callerExtensionId?: string;
    }
  ) => {
    const toolName = options?.toolName;
    if (!toolName) {
      throw new Error('toolName is required');
    }
    const callerExtensionId = options?.callerExtensionId;
    if (!callerExtensionId) {
      throw new Error('callerExtensionId is required for backend tool call');
    }

    // Resolve the workspace: explicit arg wins, else the window's active
    // project (honors the project rail selection in Multi-Project mode), else
    // the offscreen mount's workspace when the sender is the hidden screenshot
    // capture window, which WindowManager never registers.
    let workspacePath = options?.workspacePath;
    if (!workspacePath) {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const windowId = browserWindow ? getWindowId(browserWindow) : null;
      workspacePath = resolveSenderWorkspacePath({
        windowId,
        webContentsId: event.sender?.id,
      });
    }
    if (!workspacePath) {
      throw new Error('No workspace path available for backend tool call');
    }

    // Resolve worktree paths to the project path the backend module was started
    // for, then route to the module over the typed RPC bridge.
    const resolved = await resolveBackendWorkspacePath(workspacePath);

    // Enforce caller ownership of the tool. Fail closed: an unknown tool and a
    // cross-extension call both reject without dispatching.
    const entry = findOwnedBackendTool(resolved, toolName, callerExtensionId);
    if (!entry) {
      throw new Error(`Backend tool not available to this extension: ${toolName}`);
    }

    const result = await handleBackendTool(toolName, toolName, options?.args ?? {}, resolved, {
      sessionId: null,
      caller: 'panel',
      extensionId: callerExtensionId,
    });
    const text = result.content?.[0]?.text ?? '';
    if (result.isError) {
      throw new Error(text || `Backend tool ${toolName} failed`);
    }
    try {
      return JSON.parse(text);
    } catch {
      // Tool returned a non-JSON string payload; hand it back as-is.
      return text;
    }
  });

  // Extension SDK: List available chat models
  safeHandle('extensions:ai-list-models', async () => {
    const CHAT_PROVIDERS: AIProviderType[] = ['claude', 'openai', 'lmstudio'];
    const providerSettings = ctx.getNormalizedProviderSettings() as any;
    const globalApiKeys = getProviderCredentials().availableKeys();

    const allModels: Array<{ id: string; name: string; provider: string }> = [];

    for (const provider of CHAT_PROVIDERS) {
      // Check if provider is enabled
      const settings = providerSettings?.[provider];
      if (settings && settings.enabled === false) continue;

      const apiKey = provider === 'claude' ? globalApiKeys['anthropic']
        : provider === 'openai' ? globalApiKeys['openai']
        : undefined;
      const baseUrl = provider === 'lmstudio' ? (ctx.getSettingsStore().get('apiKeys.lmstudio_url', '') as string || undefined) : undefined;

      try {
        // CHAT_PROVIDERS above is claude/openai/lmstudio -- none project-scoped.
        const models = await ModelRegistry.getModelsForProvider(provider, undefined, apiKey, baseUrl);
        const enabledModelIds = settings?.models as string[] | undefined;

        for (const model of models) {
          // If provider has specific model selections, filter to those
          if (enabledModelIds && enabledModelIds.length > 0 && !enabledModelIds.includes(model.id)) {
            continue;
          }
          allModels.push({
            id: model.id,
            name: model.name,
            provider: model.provider,
          });
        }
      } catch (err) {
        // console.warn(`[AIService] Failed to list models for ${provider}:`, err);
      }
    }

    return allModels;
  });

  // Extension SDK: Stateless chat completion (full response)
  safeHandle('extensions:ai-chat-completion', async (
    event,
    options: {
      messages: Array<{ role: string; content: string }>;
      model?: string;
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
      responseFormat?: any;
    }
  ) => {
    return handleExtensionChatCompletion(ctx, event, options);
  });

  // Extension SDK: Streaming chat completion - start
  const activeStreams = new Map<string, AIProvider>();

  safeHandle('extensions:ai-chat-completion-stream-start', async (
    event,
    options: {
      streamId: string;
      messages: Array<{ role: string; content: string }>;
      model?: string;
      maxTokens?: number;
      temperature?: number;
      systemPrompt?: string;
      responseFormat?: any;
    }
  ) => {
    const { streamId, ...completionOptions } = options;
    const { provider, providerConfig, syntheticSessionId } = await resolveExtensionChatProvider(ctx, event, completionOptions);

    activeStreams.set(streamId, provider);

    // Build messages for the provider
    const { currentMessage, previousMessages } = buildProviderMessages(completionOptions);

    // Stream in the background
    (async () => {
      let fullContent = '';
      let usage: { inputTokens: number; outputTokens: number } | undefined;

      try {
        const iterator = provider.sendMessage(
          currentMessage,
          undefined,  // no document context
          syntheticSessionId,
          previousMessages,
        );

        for await (const chunk of iterator) {
          if (event.sender.isDestroyed()) break;

          if (chunk.type === 'text' && chunk.content) {
            fullContent += chunk.content;
            safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
              streamId,
              chunk: { type: 'text', content: chunk.content },
            });
          } else if (chunk.type === 'error') {
            safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
              streamId,
              chunk: { type: 'error', error: chunk.error || 'Unknown error' },
            });
            return;
          } else if (chunk.type === 'complete') {
            if (chunk.content) fullContent = chunk.content;
            if (chunk.usage) {
              usage = {
                inputTokens: chunk.usage.input_tokens,
                outputTokens: chunk.usage.output_tokens,
              };
            }
          }
        }

        safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
          streamId,
          chunk: { type: 'done' },
          result: {
            content: fullContent,
            model: providerConfig.model || '',
            usage,
          },
        });
      } catch (err: any) {
        safeSend(event, 'extensions:ai-chat-completion-stream-chunk', {
          streamId,
          chunk: { type: 'error', error: err.message || 'Stream failed' },
        });
      } finally {
        activeStreams.delete(streamId);
        ProviderFactory.destroyProvider(syntheticSessionId);
      }
    })();

    return { streamId };
  });

  // Extension SDK: Streaming chat completion - abort
  safeHandle('extensions:ai-chat-completion-stream-abort', async (_event, streamId: string) => {
    const provider = activeStreams.get(streamId);
    if (provider) {
      provider.abort();
      activeStreams.delete(streamId);
    }
  });
}

async function resolveExtensionChatProvider(
  ctx: AIServiceContext,
  event: Electron.IpcMainInvokeEvent,
  options: { model?: string; maxTokens?: number; temperature?: number; responseFormat?: any }
): Promise<{ provider: AIProvider; providerConfig: ProviderConfig; providerType: AIProviderType; syntheticSessionId: string }> {
  const CHAT_PROVIDERS: AIProviderType[] = ['claude', 'openai', 'lmstudio'];

  // Determine provider from model ID or find first available
  let providerType: AIProviderType | undefined;
  let modelId: string | undefined;

  if (options.model) {
    const parsed = ModelIdentifier.tryParse(options.model);
    if (parsed && CHAT_PROVIDERS.includes(parsed.provider as AIProviderType)) {
      providerType = parsed.provider as AIProviderType;
      modelId = parsed.model;
    } else {
      // Try to find this model across providers
      for (const p of CHAT_PROVIDERS) {
        const models = await ModelRegistry.getModelsForProvider(p, undefined);
        if (models.some(m => m.id === options.model)) {
          providerType = p;
          modelId = options.model;
          break;
        }
      }
    }
  }

  if (!providerType) {
    // Find first enabled chat provider
    for (const p of CHAT_PROVIDERS) {
      if (ctx.isProviderEnabledForWorkspace(p)) {
        providerType = p;
        break;
      }
    }
  }

  if (!providerType) {
    throw new Error('No chat provider available. Enable Claude, OpenAI, or LM Studio in Settings > AI.');
  }

  // Get API key
  const apiKey = ctx.getApiKeyForProvider(providerType);
  if (providerType !== 'lmstudio' && !apiKey) {
    throw new Error(`API key not configured for provider ${providerType}. Configure it in Settings > AI.`);
  }

  // Resolve model
  if (!modelId) {
    const defaultModel = await ModelRegistry.getDefaultModel(providerType);
    const extracted = extractModelForProvider(defaultModel, providerType);
    modelId = extracted || defaultModel;
  }

  const providerConfig: ProviderConfig = {
    apiKey,
    model: modelId,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    responseFormat: options.responseFormat,
    skipLogging: true,
  };

  // LM Studio needs baseUrl
  if (providerType === 'lmstudio') {
    providerConfig.baseUrl = ctx.getSettingsStore().get('apiKeys.lmstudio_url', '') as string || 'http://127.0.0.1:1234';
  }

  const syntheticSessionId = `ext-completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const provider = ProviderFactory.createProvider(providerType, syntheticSessionId);
  await provider.initialize(providerConfig);

  return { provider, providerConfig, providerType, syntheticSessionId };
}

/**
 * Convert extension ChatCompletionMessage[] into the format expected by providers:
 * a current user message string and an array of previous Message objects.
 */
function buildProviderMessages(options: {
  messages: Array<{ role: string; content: string }>;
  systemPrompt?: string;
}): { currentMessage: string; previousMessages: Message[] } {
  const msgs = [...options.messages];

  // Prepend system prompt as a system message if provided
  if (options.systemPrompt) {
    msgs.unshift({ role: 'system', content: options.systemPrompt });
  }

  if (msgs.length === 0) {
    throw new Error('At least one message is required');
  }

  // The last user message becomes the "current message" argument
  // All previous messages become the messages array
  const lastMessage = msgs[msgs.length - 1];
  const currentMessage = lastMessage.content;

  const previousMessages: Message[] = msgs.slice(0, -1).map(m => ({
    role: m.role as Message['role'],
    content: m.content,
    timestamp: Date.now(),
  }));

  return { currentMessage, previousMessages };
}

/**
 * Handle a stateless (non-session) chat completion from an extension.
 */
async function handleExtensionChatCompletion(
  ctx: AIServiceContext,
  event: Electron.IpcMainInvokeEvent,
  options: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    responseFormat?: any;
  }
): Promise<{ content: string; model: string; usage?: { inputTokens: number; outputTokens: number } }> {
  const { provider, providerConfig, providerType, syntheticSessionId } = await resolveExtensionChatProvider(ctx, event, options);
  const { currentMessage, previousMessages } = buildProviderMessages(options);

  try {
    let fullContent = '';
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    const iterator = provider.sendMessage(
      currentMessage,
      undefined,  // no document context
      syntheticSessionId,
      previousMessages,
    );

    for await (const chunk of iterator) {
      if (chunk.type === 'text' && chunk.content) {
        fullContent += chunk.content;
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error || 'Provider error');
      } else if (chunk.type === 'complete') {
        if (chunk.content) fullContent = chunk.content;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.input_tokens,
            outputTokens: chunk.usage.output_tokens,
          };
        }
      }
    }

    return {
      content: fullContent,
      model: providerConfig.model || '',
      usage,
    };
  } finally {
    ProviderFactory.destroyProvider(syntheticSessionId, providerType);
  }
}
