import { BaseAgentProvider } from './BaseAgentProvider';
import type {
  AIModel,
  DocumentContext,
  ProviderCapabilities,
  ProviderConfig,
  StreamChunk,
} from '../types';
import { buildUserMessageAddition } from './documentContextUtils';
import { invokeModelLauncher } from './modelLauncher/modelLauncherAdapter';
import {
  getModelLauncherModels,
  getModelLauncherProfile,
  MODEL_LAUNCHER_PROVIDER_ID,
} from './modelLauncher/modelLauncherProfiles';

interface ModelLauncherProviderDeps {
  invoke?: typeof invokeModelLauncher;
}

export class ModelLauncherProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = `${MODEL_LAUNCHER_PROVIDER_ID}:deepseek-pro`;
  private readonly invoke: typeof invokeModelLauncher;

  constructor(deps?: ModelLauncherProviderDeps) {
    super();
    this.invoke = deps?.invoke ?? invokeModelLauncher;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    if (!getModelLauncherProfile(config.model ?? ModelLauncherProvider.DEFAULT_MODEL)) {
      throw new Error(`Unsupported Unified Model Launcher profile: ${config.model || '(empty)'}`);
    }
    if (config.effortLevel && !['low', 'medium', 'high', 'xhigh'].includes(config.effortLevel)) {
      throw new Error(`Unsupported Unified Model Launcher effort: ${config.effortLevel}`);
    }
    this.config = config;
  }

  getProviderName(): string {
    return MODEL_LAUNCHER_PROVIDER_ID;
  }

  getDisplayName(): string {
    return 'Model Launcher';
  }

  getDescription(): string {
    return 'Approved workspace model profiles through the Unified Model Launcher';
  }

  getProviderSessionData(): null {
    return null;
  }

  override getCapabilities(): ProviderCapabilities {
    return {
      streaming: false,
      tools: false,
      mcpSupport: false,
      edits: false,
      resumeSession: false,
      supportsFileTools: false,
    };
  }

  static async getModels(): Promise<AIModel[]> {
    return getModelLauncherModels();
  }

  static getDefaultModel(): string {
    return ModelLauncherProvider.DEFAULT_MODEL;
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: unknown[],
    workspacePath?: string,
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: 'Unified Model Launcher requires an active workspace.' };
      return;
    }
    const profile = getModelLauncherProfile(this.config.model ?? ModelLauncherProvider.DEFAULT_MODEL);
    if (!profile) {
      yield { type: 'error', error: 'The selected launcher profile is not approved.' };
      return;
    }

    const { messageWithContext } = buildUserMessageAddition(message, documentContext);
    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      const result = await this.invoke({
        workspacePath,
        profile,
        task: messageWithContext,
        effort: this.config.effortLevel as 'low' | 'medium' | 'high' | 'xhigh' | undefined,
        sessionId,
        signal: abortController.signal,
      });
      yield { type: 'text', content: result.output };
      yield { type: 'complete', content: result.output, isComplete: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: message };
    } finally {
      if (this.abortController === abortController) this.abortController = null;
    }
  }
}
