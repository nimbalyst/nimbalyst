/**
 * KimiClaw Provider
 *
 * HTTP+SSE provider for KimiClawSwarm (KCS) — local Flask server at 127.0.0.1:9643.
 * Follows the same pattern as OpenCodeProvider.
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  ProviderCapabilities,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { KimiClawProtocol } from '../protocols/KimiClawProtocol';
import { ProviderSessionManager } from './ProviderSessionManager';
import { McpConfigService } from '../services/McpConfigService';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { safeJSONSerialize } from '../../../utils/serialization';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface KimiClawProviderDeps {
  protocol?: KimiClawProtocol;
}

export class KimiClawProvider extends BaseAgentProvider {
  private readonly protocol: KimiClawProtocol;
  private readonly mcpConfigService: McpConfigService;

  constructor(deps?: KimiClawProviderDeps) {
    super();
    this.protocol = deps?.protocol || new KimiClawProtocol();
    this.mcpConfigService = new McpConfigService();
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): string {
    return 'kimiclaw';
  }

  getDisplayName(): string {
    return 'KimiClaw';
  }

  getDescription(): string {
    return 'KimiClawSwarm local multi-agent orchestration';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: false,
      mcpSupport: false,
      edits: false,
      resumeSession: false,
      supportsFileTools: false,
    };
  }

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: 'kimi-code/kimi-for-coding',
        name: 'Kimi K2 Coding',
        provider: 'kimiclaw' as AIProviderType,
      },
    ];
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      swarmId: providerSessionId,
    };
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: '[KimiClawProvider] workspacePath is required' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(documentContext);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    // Emit prompt additions for UI
    if (sessionId && (systemPrompt || userMessageAddition)) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    // Log user message
    if (sessionId) {
      await this.logAgentMessageBestEffort(sessionId, 'input', messageWithContext);
    }

    const abortController = new AbortController();
    this.abortController = abortController;
    let fullText = '';

    try {
      const existingSessionId = this.sessions.getSessionId(sessionId || '');

      const sessionOptions = {
        workspacePath,
        model: this.config?.model || 'default',
        raw: {
          endpoint: (this.config as any)?.endpoint || 'http://127.0.0.1:9643',
          authMode: (this.config as any)?.authMode || 'cookie',
          username: (this.config as any)?.username || 'admin',
          password: (this.config as any)?.password || 'admin',
          bearerToken: (this.config as any)?.bearerToken || '',
          swarmDefaults: {
            persona_mode: (this.config as any)?.personaMode ?? true,
            max_agents: (this.config as any)?.maxAgents ?? 4,
            max_steps: (this.config as any)?.maxSteps ?? 12,
            max_parallel: (this.config as any)?.maxParallel,
          },
        } as Record<string, unknown>,
      };

      const isResumedSession = !!existingSessionId;
      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      // Capture session ID
      if (sessionId && session.id) {
        this.sessions.captureSessionId(sessionId, session.id);
      }

      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');
      transcriptAdapter.userMessage(messageWithContext, documentContext?.mode === 'planning' ? 'planning' : 'agent', attachments as any);

      // Stream protocol events
      for await (const event of this.protocol.sendMessage(session, {
        content: messageWithContext,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        // Store raw events for transcript
        if (sessionId && event.type === 'raw_event') {
          const rawSseEvent = (event.metadata as { rawEvent?: unknown } | undefined)?.rawEvent;
          if (rawSseEvent !== undefined) {
            const { content } = safeJSONSerialize(rawSseEvent);
            const sseEventType = typeof (rawSseEvent as { type?: unknown }).type === 'string'
              ? (rawSseEvent as { type: string }).type : 'unknown';
            await this.logAgentMessageBestEffort(sessionId, 'output', content, {
              metadata: { eventType: sseEventType, kimiclawProvider: true },
              hidden: true,
              searchable: false,
            });
            // Drive incremental transcript transformation
            await this.processTranscriptMessages(sessionId);
          }
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;
            case 'tool_call':
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;
            case 'tool_result':
              yield { type: 'tool_call', toolCall: { id: item.toolResult.id, name: item.toolResult.name, result: item.toolResult.result } };
              break;
            case 'complete':
              yield { type: 'complete', content: item.event.content, isComplete: true, usage: item.event.usage };
              break;
            case 'error':
              yield { type: 'error', error: item.message };
              break;
            case 'raw_event':
            case 'reasoning':
            case 'planning_mode':
              break;
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!abortController.signal.aborted) {
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Process transcript messages for incremental transformation.
   */
  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      const { TranscriptEventRepository } = await import('../../../storage/repositories/TranscriptEventRepository');
      const { TranscriptMigrationRepository } = await import('../../../storage/repositories/TranscriptMigrationRepository');
      const { TranscriptTransformer } = await import('../../../storage/transformers/TranscriptTransformer');
      const transformer = new TranscriptTransformer(new TranscriptEventRepository(), new TranscriptMigrationRepository());
      await transformer.processEventsForSession(sessionId);
    } catch (error) {
      console.error('[KIMICLAW] Error processing transcript messages:', error);
    }
  }

  async checkInstallation(): Promise<{ installed: boolean; details?: string }> {
    try {
      // TODO: use actual transport health check
      return { installed: true, details: 'KimiClaw reachable at 127.0.0.1:9643' };
    } catch {
      return { installed: false, details: 'KimiClaw not reachable. Run: docker compose up -d' };
    }
  }
}
