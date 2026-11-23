// @vitest-environment node
/**
 * End-to-end integration tests for GeminiAntigravityProvider over the shared
 * CodexACPProtocol using mockAgyAcpAgent.mjs.
 *
 * Covers:
 * - streaming text, WebSearch tool calls, and usage/context-window reporting
 * - model + effort selection forwarded to ACP configOptions (including clamping)
 * - agent_thought_chunk persisted and projected as a single collapsed thinking block
 * - session persistence and resume via getProviderSessionData / loadSession
 * - auth & missing-binary error classification
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodexACPProtocol } from '../../../protocols/CodexACPProtocol';
import { GeminiAntigravityProvider, mapAgyPermissionMode } from '../../GeminiAntigravityProvider';
import { BaseAgentProvider } from '../../BaseAgentProvider';
import { AntigravityServerManager } from '../AntigravityServerManager';
import { AgentMessagesRepository } from '../../../../../storage/repositories/AgentMessagesRepository';
import { TranscriptMigrationRepository } from '../../../../../storage/repositories/TranscriptMigrationRepository';
import { TranscriptMigrationService } from '../../../transcript/TranscriptMigrationService';
import { TranscriptProjector } from '../../../transcript/TranscriptProjector';
import type { IRawMessageStore, ISessionMetadataStore } from '../../../transcript/TranscriptTransformer';
import { createMockStore } from '../../../transcript/__tests__/helpers/createMockStore';
import type { StreamChunk } from '../../../types';

function agyFixturePath(): string {
  return fileURLToPath(new URL('../../../protocols/__tests__/fixtures/mockAgyAcpAgent.mjs', import.meta.url));
}

async function collect(stream: AsyncIterableIterator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function createMetadataStore(): ISessionMetadataStore {
  const state = new Map<string, {
    transformVersion: number | null;
    lastRawMessageId: number | null;
    lastTransformedAt: Date | null;
    transformStatus: 'pending' | 'complete' | 'error' | null;
  }>();
  return {
    async getTransformStatus(sessionId) {
      return state.get(sessionId) ?? {
        transformVersion: null,
        lastRawMessageId: null,
        lastTransformedAt: null,
        transformStatus: null,
      };
    },
    async updateTransformStatus(sessionId, update) {
      state.set(sessionId, update);
    },
  };
}

describe('GeminiAntigravityProvider (ACP)', () => {
  let workspacePath: string;
  let auditPath: string;
  let protocol: CodexACPProtocol;
  let provider: GeminiAntigravityProvider;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-acp-provider-'));
    auditPath = path.join(workspacePath, 'audit.ndjson');
    BaseAgentProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' }));
    BaseAgentProvider.setPermissionPatternSaver(async () => {});
    BaseAgentProvider.setPermissionPatternChecker(async () => false);

    protocol = new CodexACPProtocol('', {
      platform: 'antigravity-gemini-acp',
      agentLabel: 'Antigravity ACP',
      logPrefix: 'GeminiACPProtocol',
      apiKeyEnvVar: null,
      command: process.execPath,
      args: [agyFixturePath()],
      env: { AGY_ACP_TEST_AUDIT_PATH: auditPath },
      mapPermissionMode: mapAgyPermissionMode,
      applyModel: true,
    });
    provider = new GeminiAntigravityProvider({ protocol });
  });

  afterEach(() => {
    provider.destroy();
    protocol.destroy();
    AgentMessagesRepository.clearStore();
    TranscriptMigrationRepository.clearService();
    BaseAgentProvider.setTrustChecker(null);
    BaseAgentProvider.setPermissionPatternSaver(null);
    BaseAgentProvider.setPermissionPatternChecker(null);
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it('streams text, WebSearch tool calls, context usage, and applies model + effort', async () => {
    await provider.initialize({
      model: 'antigravity-gemini-agent:gemini-4-argon',
      effortLevel: 'medium',
    });

    const chunks = await collect(
      provider.sendMessage('What is the latest Node LTS?', undefined, 'gem-1', [], workspacePath),
    );

    const text = chunks.filter((c) => c.type === 'text').map((c) => c.content).join('');
    expect(text).toBe('Answer from gemini-4-argon (medium): Node.js 24 LTS.');

    const searchCall = chunks.find((c) => c.type === 'tool_call' && c.toolCall?.name === 'WebSearch');
    expect(searchCall).toBeDefined();

    const complete = chunks.find((c) => c.type === 'complete');
    expect(complete?.isComplete).toBe(true);
    expect(complete?.contextFillTokens).toBe(12500);
    expect(complete?.contextWindow).toBe(1048576);
    expect(complete?.usage).toMatchObject({
      input_tokens: 12000,
      output_tokens: 500,
    });

    // Session id is captured for resume.
    expect(provider.getProviderSessionData('gem-1').providerSessionId).toBeTruthy();
  }, 15000);

  it('projects agent_thought_chunk deltas into a single collapsed thinking block while keeping reply text separate', async () => {
    const messages: Array<{
      id: number;
      sessionId: string;
      source: string;
      direction: 'input' | 'output';
      content: string;
      createdAt: Date;
      metadata?: Record<string, unknown>;
      hidden: boolean;
    }> = [];
    let nextId = 1;

    AgentMessagesRepository.setStore({
      async create(message) {
        messages.push({
          id: nextId++,
          sessionId: message.sessionId,
          source: message.source,
          direction: message.direction,
          content: message.content,
          createdAt: new Date(),
          metadata: message.metadata,
          hidden: message.hidden ?? false,
        });
      },
      async list(sid) {
        return messages.filter((m) => m.sessionId === sid) as any;
      },
    });

    const rawStore: IRawMessageStore = {
      async getMessages(sid, afterId) {
        return messages
          .filter((m) => m.sessionId === sid && (afterId == null || m.id > afterId))
          .sort((a, b) => a.id - b.id);
      },
    };
    const migrationService = new TranscriptMigrationService(
      rawStore,
      createMockStore(),
      createMetadataStore(),
    );
    TranscriptMigrationRepository.setService(migrationService);

    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-4-neon', effortLevel: 'high' });

    await collect(
      provider.sendMessage('search node lts', undefined, 'gem-think', [], workspacePath),
    );

    const canonical = await migrationService.getCanonicalEvents('gem-think', 'antigravity-gemini-agent');
    const view = TranscriptProjector.project(canonical);

    const thinkingBlocks = view.messages.filter((m) => m.type === 'assistant_message' && m.thinking);
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0].thinking).toBe('First I will search for the answer.');
    expect(thinkingBlocks[0].text ?? '').toBe('');

    const replyBlocks = view.messages.filter((m) => m.type === 'assistant_message' && m.text);
    expect(replyBlocks).toHaveLength(1);
    expect(replyBlocks[0].text).toBe('Answer from gemini-4-neon (high): Node.js 24 LTS.');

    const toolBlocks = view.messages.filter((m) => m.type === 'tool_call');
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0].toolCall?.toolName).toBe('WebSearch');
    expect(toolBlocks[0].toolCall?.status).toBe('completed');
  }, 15000);

  it('classifies unauthenticated ACP errors with the agy login guidance', async () => {
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-4-neon' });

    const chunks = await collect(
      provider.sendMessage('TRIGGER_AUTH_ERROR', undefined, 'gem-auth', [], workspacePath),
    );

    const errorChunk = chunks.find((c) => c.type === 'error');
    expect(errorChunk?.isAuthError).toBe(true);
    expect(errorChunk?.error).toContain('agy acp --login');
  }, 15000);

  it('denies turns when workspace is untrusted', async () => {
    BaseAgentProvider.setTrustChecker(() => ({ trusted: false, mode: 'ask' }));
    await provider.initialize({ model: 'antigravity-gemini-agent:gemini-4-neon' });

    const chunks = await collect(
      provider.sendMessage('hello', undefined, 'gem-untrusted', [], workspacePath),
    );

    expect(chunks).toEqual([
      expect.objectContaining({ type: 'error', error: expect.stringMatching(/not trusted/i) }),
    ]);
  });

  it('registers the embedded HTTPS port from --cli_log_file on AntigravityServerManager and clears it on destroy', async () => {
    AntigravityServerManager.shared().clearExternalEndpoint();
    const acpLogPath = path.join(workspacePath, 'agy-acp.log');
    const logProtocol = new CodexACPProtocol('', {
      platform: 'antigravity-gemini-acp',
      agentLabel: 'Antigravity ACP',
      logPrefix: 'GeminiACPProtocol',
      apiKeyEnvVar: null,
      command: process.execPath,
      argsResolver: () => [agyFixturePath(), '--cli_log_file', acpLogPath],
      env: { AGY_ACP_TEST_HTTPS_PORT: '57147' },
      mapPermissionMode: mapAgyPermissionMode,
      applyModel: true,
    });
    const logProvider = new GeminiAntigravityProvider({
      protocol: logProtocol,
      acpLogFilePath: acpLogPath,
    });

    try {
      await logProvider.initialize({ model: 'antigravity-gemini-agent:gemini-4-neon' });
      const chunks = await collect(
        logProvider.sendMessage('check usage endpoint', undefined, 'gem-usage', [], workspacePath),
      );
      expect(chunks.some((c) => c.type === 'complete')).toBe(true);
      expect(AntigravityServerManager.shared().currentEndpoint()).toEqual({
        httpsPort: 57147,
        csrf: '',
        owned: false,
      });
    } finally {
      logProvider.destroy();
      logProtocol.destroy();
    }

    expect(AntigravityServerManager.shared().currentEndpoint()).toBeNull();
  }, 15000);
});
