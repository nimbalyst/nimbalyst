// @vitest-environment node
/**
 * Codex system-prompt inputs that must stay stable for a whole session:
 * developer_instructions are re-sent at the head of every turn, so the session
 * directive and the out-of-band naming decision are read once and frozen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICodexProvider } from '../OpenAICodexProvider';
import { configureMcpServers } from '../../services/mcpServerConfig';
import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';

// getModels() cross-checks the OpenAI model catalogue when given an API key;
// keep it off the network (see OpenAICodexProvider.test.ts).
vi.mock('openai', () => ({
  default: class {
    models = { list: async () => ({ data: [] as Array<{ id: string }> }) };
  },
}));

function createAsyncEventStream(events: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('OpenAICodexProvider session-stable system prompt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    configureMcpServers({ mcpServerPort: null, extensionDevServerPort: null });
    OpenAICodexProvider.setMCPConfigLoader(null);
    OpenAICodexProvider.setClaudeSettingsEnvLoader(null);
    OpenAICodexProvider.setShellEnvironmentLoader(null);
    OpenAICodexProvider.setEnhancedPathLoader(null);
    OpenAICodexProvider.setPreEditHookScriptPathResolver(null);
    OpenAICodexProvider.setPreEditSidecarDirResolver(null);
    OpenAICodexProvider.setCodexTransportResolver(null);
    OpenAICodexProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' as any }));
    OpenAICodexProvider.setPermissionPatternChecker(async () => false);
    OpenAICodexProvider.setPermissionPatternSaver(async () => {});
    OpenAICodexProvider.setSecurityLogger(() => {});
  });

  // developer_instructions are re-sent at the head of every turn, so the
  // directive is read once and frozen, same as claude-code's appended prompt.
  it('appends the session directive from metadata and freezes it for the session', async () => {
    const startThread = vi.fn(() => ({
      id: 'thread-directive',
      runStreamed: async () => ({
        events: createAsyncEventStream([{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]),
      }),
    }));
    let sessionDirective = 'Only triage GitHub issues.';
    vi.spyOn(AISessionsRepository, 'get').mockImplementation(async () => ({ metadata: { sessionDirective } }) as any);
    configureMcpServers({ mcpServerPort: 41001 });

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({ Codex: class { startThread = startThread; resumeThread = startThread; } }) as any,
      }
    );
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5.5' });
    const systemPrompts: string[] = [];
    provider.on('promptAdditions', (payload: { systemPromptAddition: string }) => {
      systemPrompts.push(payload.systemPromptAddition);
    });

    for (const message of ['turn one', 'turn two']) {
      for await (const _chunk of provider.sendMessage(message, undefined, 'session-directive', [], process.cwd())) {
        // drain
      }
      sessionDirective = 'Directive edited mid-session.';
    }

    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[0]).toContain('Only triage GitHub issues.');
    expect(systemPrompts[1]).toBe(systemPrompts[0]);
  });

  // A session titled by its caller (spawn_session, an extension-owned session)
  // must not be told to name itself, or the agent's update_session_meta call
  // replaces that title. Frozen at the first turn like claude-code's decision:
  // hasBeenNamed flips when an unnamed session names itself, and the prompt is
  // re-sent every turn.
  it('tells a caller-named session not to set its name, and keeps that decision for the session', async () => {
    const startThread = vi.fn(() => ({
      id: 'thread-named',
      runStreamed: async () => ({
        events: createAsyncEventStream([{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }]),
      }),
    }));
    vi.spyOn(AISessionsRepository, 'get').mockImplementation(async () => ({ metadata: {} }) as any);
    configureMcpServers({ mcpServerPort: 41001 });

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({ Codex: class { startThread = startThread; resumeThread = startThread; } }) as any,
      }
    );
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5.5' });
    const systemPrompts: string[] = [];
    provider.on('promptAdditions', (payload: { systemPromptAddition: string }) => {
      systemPrompts.push(payload.systemPromptAddition);
    });

    const turns: Array<[string, boolean]> = [['named-session', true], ['named-session', false], ['fresh-session', false], ['fresh-session', true]];
    for (const [sessionId, hasBeenNamed] of turns) {
      for await (const _chunk of provider.sendMessage('go', { hasBeenNamed } as any, sessionId, [], process.cwd())) {
        // drain
      }
    }

    expect(systemPrompts).toHaveLength(4);
    expect(systemPrompts[0]).toContain('do NOT set `name`');
    expect(systemPrompts[1]).toBe(systemPrompts[0]);
    expect(systemPrompts[2]).toContain('CRITICAL: You MUST call this tool');
    expect(systemPrompts[3]).toBe(systemPrompts[2]);
  });
});
