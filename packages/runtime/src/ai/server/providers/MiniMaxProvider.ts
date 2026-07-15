import type { AIProvider } from '../AIProvider';
import { BaseAIProvider } from '../AIProvider';
import type {
  AgentToolDefinition,
  AIModel,
  DocumentContext,
  ProviderCapabilities,
  ProviderConfig,
  StreamChunk,
  ToolHandler,
} from '../types';
import { ModelIdentifier } from '../ModelIdentifier';
import { ClaudeProvider } from './ClaudeProvider';
import { OpenAIProvider } from './OpenAIProvider';

export const MINIMAX_ENDPOINTS = {
  global_en: {
    openai: 'https://api.minimax.io/v1',
    anthropic: 'https://api.minimax.io/anthropic',
  },
  cn_zh: {
    openai: 'https://api.minimaxi.com/v1',
    anthropic: 'https://api.minimaxi.com/anthropic',
  },
} as const;

export type MiniMaxProtocol = keyof typeof MINIMAX_ENDPOINTS.global_en;
export type MiniMaxRegion = keyof typeof MINIMAX_ENDPOINTS;

export interface MiniMaxEndpoint {
  baseUrl: string;
  protocol: MiniMaxProtocol;
  region: MiniMaxRegion;
}

const MINIMAX_MODELS = [
  { id: 'MiniMax-M3', contextWindow: 1000000 },
  { id: 'MiniMax-M2.7', contextWindow: 204800 },
] as const;

const FORWARDED_EVENTS = [
  'message:logged',
  'promptAdditions',
  'tool:start',
  'tool:complete',
  'tool:error',
] as const;

export function resolveMiniMaxEndpoint(baseUrl?: string): MiniMaxEndpoint {
  const normalized = (baseUrl || MINIMAX_ENDPOINTS.global_en.openai).replace(/\/+$/, '');

  for (const region of Object.keys(MINIMAX_ENDPOINTS) as MiniMaxRegion[]) {
    for (const protocol of Object.keys(MINIMAX_ENDPOINTS[region]) as MiniMaxProtocol[]) {
      if (MINIMAX_ENDPOINTS[region][protocol] === normalized) {
        return { baseUrl: normalized, protocol, region };
      }
    }
  }

  throw new Error('Unsupported MiniMax endpoint');
}

class MiniMaxOpenAIAdapter extends OpenAIProvider {
  protected getProviderId(): AIModel['provider'] {
    return 'minimax';
  }
}

class MiniMaxAnthropicAdapter extends ClaudeProvider {
  protected getProviderId(): AIModel['provider'] {
    return 'minimax';
  }

  protected getClientDefaultHeaders(): undefined {
    return undefined;
  }
}

export class MiniMaxProvider extends BaseAIProvider {
  static readonly DEFAULT_MODEL = ModelIdentifier.create('minimax', MINIMAX_MODELS[0].id).combined;

  private delegate: AIProvider | null = null;
  private forwardedListeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];

  async initialize(config: ProviderConfig): Promise<void> {
    if (!config.apiKey) {
      throw new Error('API key required for MiniMax provider');
    }

    const endpoint = resolveMiniMaxEndpoint(config.baseUrl);
    const parsedModel = config.model ? ModelIdentifier.tryParse(config.model) : null;
    this.releaseDelegate();

    this.config = {
      ...config,
      baseUrl: endpoint.baseUrl,
      model: parsedModel?.provider === 'minimax'
        ? parsedModel.model
        : config.model || MINIMAX_MODELS[0].id,
    };

    const delegate = endpoint.protocol === 'anthropic'
      ? new MiniMaxAnthropicAdapter()
      : new MiniMaxOpenAIAdapter();

    for (const event of FORWARDED_EVENTS) {
      const listener = (...args: any[]) => this.emit(event, ...args);
      delegate.on(event, listener);
      this.forwardedListeners.push({ event, listener });
    }

    if (this.toolHandler) {
      delegate.registerToolHandler(this.toolHandler);
    }

    this.delegate = delegate;
    try {
      await delegate.initialize(this.config);
    } catch (error) {
      this.releaseDelegate();
      throw error;
    }
  }

  sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    workspacePath?: string,
    attachments?: any[],
    tools?: AgentToolDefinition[],
    systemPrompt?: string,
  ): AsyncIterableIterator<StreamChunk> {
    if (!this.delegate) {
      throw new Error('MiniMax provider not initialized');
    }

    return this.delegate.sendMessage(
      message,
      documentContext,
      sessionId,
      messages,
      workspacePath,
      attachments,
      tools,
      systemPrompt,
    );
  }

  abort(): void {
    this.delegate?.abort();
  }

  getCapabilities(): ProviderCapabilities {
    return this.delegate?.getCapabilities() ?? {
      streaming: true,
      tools: true,
      mcpSupport: false,
      edits: true,
      resumeSession: false,
      supportsFileTools: false,
    };
  }

  registerToolHandler(handler: ToolHandler): void {
    super.registerToolHandler(handler);
    this.delegate?.registerToolHandler(handler);
  }

  destroy(): void {
    this.releaseDelegate();
    super.destroy();
  }

  static getModels(): AIModel[] {
    return MINIMAX_MODELS.map((model) => ({
      id: ModelIdentifier.create('minimax', model.id).combined,
      name: model.id,
      provider: 'minimax',
      contextWindow: model.contextWindow,
    }));
  }

  static getDefaultModel(): string {
    return this.DEFAULT_MODEL;
  }

  static isModelAllowed(modelId: string): boolean {
    const parsed = ModelIdentifier.tryParse(modelId);
    const cleanId = parsed ? parsed.model : modelId;
    return MINIMAX_MODELS.some((model) => model.id === cleanId);
  }

  private releaseDelegate(): void {
    if (!this.delegate) {
      this.forwardedListeners = [];
      return;
    }

    for (const { event, listener } of this.forwardedListeners) {
      this.delegate.off(event, listener);
    }
    this.forwardedListeners = [];
    this.delegate.destroy();
    this.delegate = null;
  }
}
