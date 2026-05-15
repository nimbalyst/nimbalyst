import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICodexProvider } from '../OpenAICodexProvider';
import * as codexBinaryPath from '../codex/codexBinaryPath';
import * as codexSdkLoader from '../codex/codexSdkLoader';
import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';

function createAsyncEventStream(events: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

describe('OpenAICodexProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset all static configuration to null for clean test isolation
    OpenAICodexProvider.setTrustChecker(null);
    OpenAICodexProvider.setPermissionPatternChecker(null);
    OpenAICodexProvider.setPermissionPatternSaver(null);
    OpenAICodexProvider.setSecurityLogger(null);
    OpenAICodexProvider.setMcpServerPort(null);
    OpenAICodexProvider.setSessionNamingServerPort(null);
    OpenAICodexProvider.setExtensionDevServerPort(null);
    OpenAICodexProvider.setMCPConfigLoader(null);
    OpenAICodexProvider.setClaudeSettingsEnvLoader(null);
    OpenAICodexProvider.setShellEnvironmentLoader(null);
    OpenAICodexProvider.setEnhancedPathLoader(null);

    // Provide default injected dependencies required by the provider.
    OpenAICodexProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' as any }));
    OpenAICodexProvider.setPermissionPatternChecker(async () => false);
    OpenAICodexProvider.setPermissionPatternSaver(async () => {});
    OpenAICodexProvider.setSecurityLogger(() => {});
  });

  it('returns fallback models when SDK model discovery is unavailable', async () => {
    expect(OpenAICodexProvider.DEFAULT_MODEL).toBe('openai-codex:gpt-5.4');

    const models = await OpenAICodexProvider.getModels(undefined, {
      loadSdkModule: async () => {
        throw new Error('sdk unavailable');
      },
    });

    expect(models.length).toBeGreaterThan(1);
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openai-codex:gpt-5.4',
        provider: 'openai-codex',
      }),
      expect.objectContaining({
        id: 'openai-codex:gpt-5.3-codex',
        provider: 'openai-codex',
      }),
    ]));
  });

  it('uses SDK-provided model discovery when available', async () => {
    let codexConstructorOptions: Record<string, unknown> | undefined;
    const listModels = vi.fn(async () => ({
      data: [
        {
          id: 'gpt-5.2-codex',
          name: 'GPT-5.2 Codex',
          contextWindow: 400000,
          maxTokens: 128000,
        },
      ],
    }));

    const models = await OpenAICodexProvider.getModels('test-key', {
      loadSdkModule: async () =>
        ({
          Codex: class {
            constructor(options?: Record<string, unknown>) {
              codexConstructorOptions = options;
            }

            listModels = listModels;

            startThread = vi.fn();

            resumeThread = vi.fn();
          },
        }) as any,
    });

    expect(codexConstructorOptions).toEqual({ apiKey: 'test-key' });
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openai-codex:gpt-5.5',
        provider: 'openai-codex',
      }),
      expect.objectContaining({
        id: 'openai-codex:gpt-5.4',
        provider: 'openai-codex',
      }),
      expect.objectContaining({
        id: 'openai-codex:gpt-5.3-codex',
        provider: 'openai-codex',
      }),
      expect.objectContaining({
        id: 'openai-codex:gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        provider: 'openai-codex',
      }),
      expect.objectContaining({
        id: 'openai-codex:gpt-5.1-codex-max',
        provider: 'openai-codex',
      }),
      expect.objectContaining({
        id: 'openai-codex:gpt-5.2',
        provider: 'openai-codex',
      }),
      expect.objectContaining({
        id: 'openai-codex:gpt-5.1-codex-mini',
        provider: 'openai-codex',
      }),
    ]));
    expect(models).toHaveLength(7);
  });

  it('preserves CLI auth when initialized without an API key', async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    let codexConstructorOptions: Record<string, unknown> | undefined;
    const runStreamed = vi.fn(async () => ({
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'cli auth response',
          },
        },
      ]),
    }));

    try {
      const provider = new OpenAICodexProvider(
        undefined,
        {
          loadSdkModule: async () =>
            ({
              Codex: class {
                constructor(options?: Record<string, unknown>) {
                  codexConstructorOptions = options;
                }

                startThread = vi.fn(() => ({
                  id: 'thread-cli-auth',
                  runStreamed,
                }));

                resumeThread = vi.fn();
              },
            }) as any,
        }
      );

      await provider.initialize({
        model: 'openai-codex:gpt-5.4',
      });

      for await (const _chunk of provider.sendMessage('use cli auth', undefined, 'session-cli-auth', [], process.cwd())) {
        // drain
      }
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }

    expect(codexConstructorOptions?.apiKey).toBeUndefined();
  });

  it('applies an API key provided during initialize', async () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    let codexConstructorOptions: Record<string, unknown> | undefined;
    const runStreamed = vi.fn(async () => ({
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'api key response',
          },
        },
      ]),
    }));

    try {
      const provider = new OpenAICodexProvider(
        undefined,
        {
          loadSdkModule: async () =>
            ({
              Codex: class {
                constructor(options?: Record<string, unknown>) {
                  codexConstructorOptions = options;
                }

                startThread = vi.fn(() => ({
                  id: 'thread-api-key',
                  runStreamed,
                }));

                resumeThread = vi.fn();
              },
            }) as any,
        }
      );

      await provider.initialize({
        apiKey: 'test-key',
        model: 'openai-codex:gpt-5.4',
      });

      for await (const _chunk of provider.sendMessage('use api key', undefined, 'session-api-key', [], process.cwd())) {
        // drain
      }
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }

    expect(codexConstructorOptions).toMatchObject({ apiKey: 'test-key' });
  });

  it('streams text and completion usage from Codex SDK events', async () => {
    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-123',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'hello from codex',
          },
        },
        {
          type: 'token_count',
          info: {
            input_tokens: 3,
            output_tokens: 7,
            total_tokens: 10,
          },
        },
      ]),
    }));

    const startThread = vi.fn(() => ({
      id: 'thread-123',
      runStreamed,
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = vi.fn();
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('say hello', undefined, 'session-1', [], process.cwd())) {
      chunks.push(chunk);
    }

    expect(startThread).toHaveBeenCalledTimes(1);
    expect(runStreamed).toHaveBeenCalledTimes(1);
    // Text chunks are also yielded alongside canonical events so AIService
    // can populate fullResponse for OS notification bodies.
    expect(chunks.some((chunk) => chunk.type === 'text')).toBe(true);

    const completeChunk = chunks.find((chunk) => chunk.type === 'complete');
    expect(completeChunk).toBeDefined();
    expect(completeChunk.usage).toEqual({
      input_tokens: 3,
      output_tokens: 7,
      total_tokens: 10,
    });

    expect(provider.getProviderSessionData('session-1')).toEqual({
      providerSessionId: 'thread-123',
      codexThreadId: 'thread-123',
    });
  });

  it('forwards image attachments to the protocol without reducing them to prompt hints', async () => {
    const createSession = vi.fn(async () => ({
      id: 'thread-image-forward',
      platform: 'codex-sdk',
      raw: { thread: { runStreamed: vi.fn() } },
    }));
    const sendMessage = vi.fn((_session, _message) => createAsyncEventStream([
      {
        type: 'complete',
        content: 'done',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    ]));
    const protocol = {
      platform: 'codex-sdk',
      createSession,
      resumeSession: vi.fn(),
      forkSession: vi.fn(),
      sendMessage,
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        protocol,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const attachments = [
      {
        id: 'img-1',
        filename: 'mockup.png',
        filepath: '/tmp/mockup.png',
        mimeType: 'image/png',
        size: 2048,
        type: 'image' as const,
        addedAt: Date.now(),
      },
    ];

    for await (const _chunk of provider.sendMessage(
      'Review this screenshot',
      undefined,
      'session-image-forward',
      [],
      process.cwd(),
      attachments
    )) {
      // drain
    }

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: expect.not.stringContaining('Attached files:'),
        attachments,
        sessionId: 'session-image-forward',
        mode: 'agent',
      })
    );
  });

  it('persists Codex input attachments in logged message metadata for transcript restoration', async () => {
    const createSession = vi.fn(async () => ({
      id: 'thread-image-metadata',
      platform: 'codex-sdk',
      raw: { thread: { runStreamed: vi.fn() } },
    }));
    const sendMessage = vi.fn((_session, _message) => createAsyncEventStream([
      {
        type: 'complete',
        content: 'done',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    ]));
    const protocol = {
      platform: 'codex-sdk',
      createSession,
      resumeSession: vi.fn(),
      forkSession: vi.fn(),
      sendMessage,
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        protocol,
      }
    );
    const logSpy = vi.spyOn(provider as any, 'logAgentMessageBestEffort').mockResolvedValue(undefined);

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const attachments = [
      {
        id: 'img-1',
        filename: 'mockup.png',
        filepath: '/tmp/mockup.png',
        mimeType: 'image/png',
        size: 2048,
        type: 'image' as const,
        addedAt: Date.now(),
      },
    ];

    for await (const _chunk of provider.sendMessage(
      'Review this screenshot',
      { mode: 'agent' },
      'session-image-metadata',
      [],
      process.cwd(),
      attachments
    )) {
      // drain
    }

    expect(logSpy).toHaveBeenCalledWith(
      'session-image-metadata',
      'input',
      expect.any(String),
      {
        metadata: {
          attachments,
          mode: 'agent',
        },
      }
    );
  });

  it('does not append unsupported-attachment hints for text documents', async () => {
    const tmpFile = path.join(os.tmpdir(), `nimbalyst-codex-provider-doc-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, 'provider attachment body', 'utf-8');

    const createSession = vi.fn(async () => ({
      id: 'thread-document-forward',
      platform: 'codex-sdk',
      raw: { thread: { runStreamed: vi.fn() } },
    }));
    const sendMessage = vi.fn((_session, _message) => createAsyncEventStream([
      {
        type: 'complete',
        content: 'done',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    ]));
    const protocol = {
      platform: 'codex-sdk',
      createSession,
      resumeSession: vi.fn(),
      forkSession: vi.fn(),
      sendMessage,
      abortSession: vi.fn(),
      cleanupSession: vi.fn(),
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        protocol,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const attachments = [
      {
        id: 'doc-1',
        filename: 'notes.txt',
        filepath: tmpFile,
        mimeType: 'text/plain',
        size: 24,
        type: 'document' as const,
        addedAt: Date.now(),
      },
    ];

    try {
      for await (const _chunk of provider.sendMessage(
        'Review @notes.txt',
        undefined,
        'session-document-forward',
        [],
        process.cwd(),
        attachments
      )) {
        // drain
      }

      expect(sendMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          content: expect.not.stringContaining('Attached files:'),
          attachments,
          sessionId: 'session-document-forward',
          mode: 'agent',
        })
      );
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  it('passes packaged codexPathOverride into SDK construction when available', async () => {
    let codexConstructorOptions: Record<string, unknown> | undefined;

    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-override',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'override path works',
          },
        },
      ]),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        resolveCodexPathOverride: () => '/tmp/codex-unpacked-bin',
        loadSdkModule: async () =>
          ({
            Codex: class {
              constructor(options?: Record<string, unknown>) {
                codexConstructorOptions = options;
              }

              startThread() {
                return {
                  id: 'thread-override',
                  runStreamed,
                };
              }

              resumeThread() {
                return {
                  id: 'thread-override',
                  runStreamed,
                };
              }
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    for await (const _chunk of provider.sendMessage('test override', undefined, 'session-override', [], process.cwd())) {
      // drain
    }

    expect(codexConstructorOptions).toMatchObject({
      apiKey: 'test-key',
      codexPathOverride: '/tmp/codex-unpacked-bin',
    });
  });

  it('wires packaged codex resolver in default provider construction path', async () => {
    OpenAICodexProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' as any }));
    OpenAICodexProvider.setPermissionPatternChecker(async () => false);
    OpenAICodexProvider.setPermissionPatternSaver(async () => {});
    OpenAICodexProvider.setSecurityLogger(() => {});

    const resolvedBinaryPath = '/tmp/codex-resolved-by-default';
    const resolveSpy = vi
      .spyOn(codexBinaryPath, 'resolvePackagedCodexBinaryPath')
      .mockReturnValue(resolvedBinaryPath);

    let codexConstructorOptions: Record<string, unknown> | undefined;
    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-default-resolver',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'default resolver wired',
          },
        },
      ]),
    }));

    vi.spyOn(codexSdkLoader, 'loadCodexSdkModule').mockResolvedValue({
      Codex: class {
        constructor(options?: Record<string, unknown>) {
          codexConstructorOptions = options;
        }

        startThread() {
          return {
            id: 'thread-default-resolver',
            runStreamed,
          };
        }

        resumeThread() {
          return {
            id: 'thread-default-resolver',
            runStreamed,
          };
        }
      },
    } as any);

    const provider = new OpenAICodexProvider({ apiKey: 'test-key' });
    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    for await (const _chunk of provider.sendMessage('test default resolver', undefined, 'session-default-resolver', [], process.cwd())) {
      // drain
    }

    expect(resolveSpy).toHaveBeenCalled();
    expect(codexConstructorOptions).toMatchObject({
      apiKey: 'test-key',
      codexPathOverride: resolvedBinaryPath,
    });
  });

  it('omits codexPathOverride from SDK options when resolver returns undefined', async () => {
    let codexConstructorOptions: Record<string, unknown> | undefined;

    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-no-override',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'no override',
          },
        },
      ]),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        resolveCodexPathOverride: () => undefined,
        loadSdkModule: async () =>
          ({
            Codex: class {
              constructor(options?: Record<string, unknown>) {
                codexConstructorOptions = options;
              }

              startThread() {
                return {
                  id: 'thread-no-override',
                  runStreamed,
                };
              }

              resumeThread() {
                return {
                  id: 'thread-no-override',
                  runStreamed,
                };
              }
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    for await (const _chunk of provider.sendMessage('test no override', undefined, 'session-no-override', [], process.cwd())) {
      // drain
    }

    expect(codexConstructorOptions).toEqual(
      expect.objectContaining({
        apiKey: 'test-key',
      }),
    );
    expect(codexConstructorOptions).not.toHaveProperty('codexPathOverride');
  });

  it('passes runtime MCP servers into Codex config overrides', async () => {
    let codexConstructorOptions: Record<string, any> | undefined;
    const workspacePath = process.cwd();

    OpenAICodexProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' as any }));
    OpenAICodexProvider.setPermissionPatternChecker(async () => false);
    OpenAICodexProvider.setPermissionPatternSaver(async () => {});
    OpenAICodexProvider.setSecurityLogger(() => {});
    OpenAICodexProvider.setMcpServerPort(41001);
    OpenAICodexProvider.setSessionNamingServerPort(41002);
    OpenAICodexProvider.setExtensionDevServerPort(41003);
    OpenAICodexProvider.setMCPConfigLoader(async () => ({
      custom_stdio: {
        command: 'npx',
        args: ['-y', '@acme/mcp'],
        env: { API_TOKEN: 'token-value' },
      },
      'customer.io': {
        command: 'npx',
        args: ['-y', '@customerio/mcp'],
      },
      custom_http: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: {
          Authorization: 'Bearer abc123',
          'X-Tenant': 'nimbalyst',
        },
      },
      'Customer.io': {
        type: 'http',
        url: 'https://mcp.customer.io/mcp',
      },
      'Customer io': {
        type: 'http',
        url: 'https://mcp.customer.io/alternate',
      },
      slack_oauth: {
        type: 'http',
        url: 'https://mcp.slack.com/mcp',
        headers: {
          'X-Tenant': 'workspace-1',
        },
        oauth: {
          callbackPort: 3118,
          clientId: 'slack-client-id',
          clientSecret: 'slack-client-secret',
          resource: 'https://slack.com',
          transportStrategy: 'http-only',
          authTimeoutSeconds: 60,
          staticClientMetadata: {
            scope: 'channels:history chat:write',
          },
        },
      },
    }));

    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-mcp-config',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'mcp configured',
          },
        },
      ]),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              constructor(options?: Record<string, unknown>) {
                codexConstructorOptions = options as Record<string, any>;
              }
              startThread() {
                return {
                  id: 'thread-mcp-config',
                  runStreamed,
                };
              }
              resumeThread() {
                return {
                  id: 'thread-mcp-config',
                  runStreamed,
                };
              }
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    for await (const _chunk of provider.sendMessage('mcp setup', undefined, 'session-mcp', [], workspacePath)) {
      // drain
    }

    expect(codexConstructorOptions?.config?.show_raw_agent_reasoning).toBe(true);
    const mcpServers = codexConstructorOptions?.config?.mcp_servers as Record<string, any>;
    expect(mcpServers).toBeDefined();
    expect(Object.keys(mcpServers)).toEqual(
      expect.arrayContaining([
        'nimbalyst-mcp',
        'nimbalyst-session-naming',
        'nimbalyst-extension-dev',
        'custom_stdio',
        'customer_io',
        'custom_http',
        'Customer_io',
        'Customer_io_2',
        'slack_oauth',
      ])
    );

    expect(mcpServers['nimbalyst-mcp'].url).toContain('http://127.0.0.1:41001/mcp');
    expect(mcpServers['nimbalyst-mcp'].url).toContain(`workspacePath=${encodeURIComponent(workspacePath)}`);
    expect(mcpServers['nimbalyst-session-naming'].url).toContain('http://127.0.0.1:41002/mcp');
    expect(mcpServers['nimbalyst-session-naming'].url).toContain('sessionId=session-mcp');
    expect(mcpServers['nimbalyst-extension-dev'].url).toContain('http://127.0.0.1:41003/mcp');
    expect(mcpServers['nimbalyst-extension-dev'].url).toContain(`workspacePath=${encodeURIComponent(workspacePath)}`);

    expect(mcpServers.custom_stdio).toEqual({
      command: 'npx',
      args: ['-y', '@acme/mcp'],
      env: { API_TOKEN: 'token-value' },
    });
    // Dots in server names are replaced with underscores to prevent TOML parsing errors
    expect(mcpServers['customer_io']).toEqual({
      command: 'npx',
      args: ['-y', '@customerio/mcp'],
    });
    expect(mcpServers.custom_http).toEqual({
      url: 'https://mcp.example.com',
      http_headers: {
        Authorization: 'Bearer abc123',
        'X-Tenant': 'nimbalyst',
      },
    });
    expect(mcpServers.Customer_io).toEqual({
      url: 'https://mcp.customer.io/mcp',
    });
    expect(mcpServers.Customer_io_2).toEqual({
      url: 'https://mcp.customer.io/alternate',
    });
    expect(mcpServers.slack_oauth).toEqual({
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        'https://mcp.slack.com/mcp',
        '3118',
        '--transport',
        'http-only',
        '--resource',
        'https://slack.com',
        '--auth-timeout',
        '60',
        '--header',
        'X-Tenant:workspace-1',
        '--static-oauth-client-metadata',
        '{"scope":"channels:history chat:write"}',
        '--static-oauth-client-info',
        '{"client_id":"slack-client-id","client_secret":"slack-client-secret"}',
      ],
    });
  });

  it('emits tool_call chunks from streamed MCP tool events', async () => {
    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-tool',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            id: 'tool-1',
            type: 'mcp_tool_call',
            server: 'nimbalyst',
            tool: 'readFile',
            arguments: { path: 'README.md' },
            status: 'completed',
            result: { content: [{ type: 'text', text: 'file contents' }] },
          },
        },
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'tool complete',
          },
        },
      ]),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread() {
                return {
                  id: 'thread-tool',
                  runStreamed,
                };
              }
              resumeThread() {
                return {
                  id: 'thread-tool',
                  runStreamed,
                };
              }
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('use tools', undefined, 'session-tool', [], process.cwd())) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.type === 'tool_call' && chunk.toolCall?.name === 'mcp__nimbalyst__readFile')).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'complete')).toBe(true);
  });

  it('keeps explicit stdio servers as stdio when stale url fields are present', async () => {
    let codexConstructorOptions: Record<string, any> | undefined;

    OpenAICodexProvider.setMCPConfigLoader(async () => ({
      supabase: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@supabase/mcp'],
        url: 'https://stale.example.com/mcp',
      },
    }));

    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-stdio-normalized',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'normalized',
          },
        },
      ]),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              constructor(options?: Record<string, unknown>) {
                codexConstructorOptions = options as Record<string, any>;
              }
              startThread() {
                return {
                  id: 'thread-stdio-normalized',
                  runStreamed,
                };
              }
              resumeThread() {
                return {
                  id: 'thread-stdio-normalized',
                  runStreamed,
                };
              }
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    for await (const _chunk of provider.sendMessage('normalize mcp', undefined, 'session-stdio-normalized', [], process.cwd())) {
      // drain
    }

    expect(codexConstructorOptions?.config?.show_raw_agent_reasoning).toBe(true);
    expect(codexConstructorOptions?.config?.mcp_servers?.supabase).toEqual({
      command: 'npx',
      args: ['-y', '@supabase/mcp'],
    });
  });

  it('allows internal MCP tools for meta-agent Codex sessions', async () => {
    const runStreamed = vi.fn(async () => ({
      threadId: 'thread-meta-agent',
      events: createAsyncEventStream([
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'meta-agent ready',
          },
        },
      ]),
    }));
    const startThread = vi.fn((options?: Record<string, unknown>) => ({
      id: 'thread-meta-agent',
      options,
      runStreamed,
    }));

    vi.spyOn(AISessionsRepository, 'get').mockResolvedValue({
      agentRole: 'meta-agent',
    } as any);

    OpenAICodexProvider.setMcpServerPort(41001);
    OpenAICodexProvider.setSessionNamingServerPort(41002);
    OpenAICodexProvider.setSessionContextServerPort(41003);
    OpenAICodexProvider.setMetaAgentServerPort(41004);

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = startThread;
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5.5',
    });

    for await (const _chunk of provider.sendMessage('delegate work', undefined, 'session-meta-agent', [], process.cwd())) {
      // drain
    }

    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
      allowedTools: expect.arrayContaining([
        'mcp__nimbalyst-meta-agent__create_session',
        'mcp__nimbalyst-meta-agent__get_session_result',
        'mcp__nimbalyst-session-naming__update_session_meta',
        'mcp__nimbalyst-session-context__get_workstream_overview',
        'TaskCreate',
        'TodoWrite',
      ]),
      disallowedTools: expect.arrayContaining([
        'Read',
        'Write',
        'Edit',
        'Bash',
      ]),
    }));
  });

  it('resumes an existing provider thread when provider session data is restored', async () => {
    const resumeThread = vi.fn(() => ({
      id: 'thread-resume',
      runStreamed: async () => ({
        events: createAsyncEventStream([
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'resumed',
            },
          },
        ]),
      }),
    }));
    const startThread = vi.fn();

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = resumeThread;
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    provider.setProviderSessionData('session-resume', {
      providerSessionId: 'thread-resume',
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('continue', undefined, 'session-resume', [], process.cwd())) {
      chunks.push(chunk);
    }

    expect(resumeThread).toHaveBeenCalledWith('thread-resume', expect.objectContaining({
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
    }));
    expect(startThread).not.toHaveBeenCalled();
    // Text chunks are also yielded alongside canonical events so AIService
    // can populate fullResponse for OS notification bodies.
    expect(chunks.some((chunk) => chunk.type === 'text')).toBe(true);
  });

  it('reuses the same live ProtocolSession across consecutive turns on one Nimbalyst session', async () => {
    // Mock protocol -- the cache lives at the provider layer, so we want to
    // pin down its create/resume/reuse behavior without depending on the SDK
    // loader path. The bug we're protecting against: every turn calling
    // protocol.resumeSession, which spawns a new child each time and orphans
    // the previous one (high-severity finding from the codex app-server
    // smoke-test review on 2026-05-14).
    const createSession = vi.fn(async () => ({
      id: 'thread-reuse',
      platform: 'codex-app-server',
      raw: { fake: true },
    }));
    const resumeSession = vi.fn();
    const cleanupSession = vi.fn();
    const sendMessage = vi.fn((_session, _message) => createAsyncEventStream([
      {
        type: 'complete',
        content: 'ok',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    ]));
    const protocol = {
      platform: 'codex-app-server',
      createSession,
      resumeSession,
      forkSession: vi.fn(),
      sendMessage,
      abortSession: vi.fn(),
      cleanupSession,
    } as any;

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      { protocol },
    );
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5' });

    // Turn 1.
    for await (const _ of provider.sendMessage('first', undefined, 'session-reuse', [], process.cwd())) {
      // drain
    }
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).not.toHaveBeenCalled();

    // Turn 2 -- must reuse the cached ProtocolSession, NOT call resumeSession
    // (which on the app-server transport would spawn another child).
    for await (const _ of provider.sendMessage('second', undefined, 'session-reuse', [], process.cwd())) {
      // drain
    }
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(resumeSession).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    // Both turns should have used the SAME ProtocolSession object the protocol
    // handed us on turn 1.
    const turn1Session = sendMessage.mock.calls[0][0];
    const turn2Session = sendMessage.mock.calls[1][0];
    expect(turn2Session).toBe(turn1Session);

    // cleanupSession on the provider must release the cached protocol session
    // so the codex child process actually dies.
    provider.cleanupSession('session-reuse');
    expect(cleanupSession).toHaveBeenCalledTimes(1);
    expect(cleanupSession).toHaveBeenCalledWith(turn1Session);
  });

  it('denies Codex turns when workspace is not trusted', async () => {
    const startThread = vi.fn();
    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = vi.fn();
            },
          }) as any,
      }
    );

    OpenAICodexProvider.setTrustChecker(() => ({
      trusted: false,
      mode: null,
    }));

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('should be blocked', undefined, 'session-trust', [], process.cwd())) {
      chunks.push(chunk);
    }

    expect(startThread).not.toHaveBeenCalled();
    const errorChunk = chunks.find((chunk) => chunk.type === 'error');
    expect(errorChunk?.error).toContain('not trusted');
  });

  it('denies Codex in ask mode (tool-level permissions not supported)', async () => {
    const startThread = vi.fn();

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = vi.fn();
            },
          }) as any,
      }
    );

    OpenAICodexProvider.setTrustChecker(() => ({
      trusted: true,
      mode: 'ask',
    }));
    OpenAICodexProvider.setPermissionPatternChecker(async () => false);

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5',
    });

    const chunks: any[] = [];
    for await (const chunk of provider.sendMessage('test message', undefined, 'session-ask', [], process.cwd())) {
      chunks.push(chunk);
    }

    // Should be denied because Codex doesn't support tool-level permissions
    expect(startThread).not.toHaveBeenCalled();
    const errorChunk = chunks.find((chunk) => chunk.type === 'error');
    expect(errorChunk?.error).toContain('Allow Edits');
    expect(errorChunk?.error).toContain('permission mode');
  });

  it('maps legacy codex model ids to gpt-5.4 when starting a thread', async () => {
    const startThread = vi.fn((config: { model: string }) => ({
      id: 'thread-legacy',
      runStreamed: async () => ({
        events: createAsyncEventStream([
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'legacy model mapped',
            },
          },
        ]),
      }),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = vi.fn();
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:openai-codex-cli',
    });

    for await (const _chunk of provider.sendMessage('legacy', undefined, 'session-legacy', [], process.cwd())) {
      // drain
    }

    expect(startThread).toHaveBeenCalledTimes(1);
    const startArgs = (startThread.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(startArgs.model).toBe('gpt-5.4');
  });

  it('maps removed codex aliases to supported model ids', async () => {
    const startThread = vi.fn((config: { model: string }) => ({
      id: 'thread-alias',
      runStreamed: async () => ({
        events: createAsyncEventStream([
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'alias model mapped',
            },
          },
        ]),
      }),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = vi.fn();
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:codex-mini-latest',
    });

    for await (const _chunk of provider.sendMessage('alias', undefined, 'session-alias', [], process.cwd())) {
      // drain
    }

    expect(startThread).toHaveBeenCalledTimes(1);
    const startArgs = (startThread.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(startArgs.model).toBe('gpt-5.1-codex-mini');
  });

  it('maps removed codex max aliases to supported model ids', async () => {
    const startThread = vi.fn((config: { model: string }) => ({
      id: 'thread-alias-max',
      runStreamed: async () => ({
        events: createAsyncEventStream([
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'alias max model mapped',
            },
          },
        ]),
      }),
    }));

    const provider = new OpenAICodexProvider(
      { apiKey: 'test-key' },
      {
        loadSdkModule: async () =>
          ({
            Codex: class {
              startThread = startThread;
              resumeThread = vi.fn();
            },
          }) as any,
      }
    );

    await provider.initialize({
      apiKey: 'test-key',
      model: 'openai-codex:gpt-5.2-codex-max',
    });

    for await (const _chunk of provider.sendMessage('alias max', undefined, 'session-alias-max', [], process.cwd())) {
      // drain
    }

    expect(startThread).toHaveBeenCalledTimes(1);
    const startArgs = (startThread.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(startArgs.model).toBe('gpt-5.2-codex');
  });

  it('supports direct handleToolCall execution through the shared tool handler', async () => {
    const provider = new OpenAICodexProvider({ apiKey: 'test-key' });
    provider.registerToolHandler({
      executeTool: async () => ({ ok: true }),
    });

    const result = await provider.handleToolCall({
      name: 'readFile',
      arguments: { path: 'README.md' },
    });

    expect(result.success).toBe(true);
    expect(result.result).toEqual({ ok: true });
  });

  describe('buildCodexEnvironment (env-key hardening)', () => {
    it('strips ANTHROPIC_API_KEY and OPENAI_API_KEY from the composed child env', () => {
      const originalAnthropic = process.env.ANTHROPIC_API_KEY;
      const originalOpenAI = process.env.OPENAI_API_KEY;

      process.env.ANTHROPIC_API_KEY = 'sk-ant-leaked-from-shell';
      process.env.OPENAI_API_KEY = 'sk-leaked-from-shell';

      OpenAICodexProvider.setShellEnvironmentLoader(() => ({
        ANTHROPIC_API_KEY: 'sk-ant-leaked-from-shellenv',
        OPENAI_API_KEY: 'sk-leaked-from-shellenv',
        AWS_PROFILE: 'dev',
      }));
      OpenAICodexProvider.setEnhancedPathLoader(() => '/opt/homebrew/bin:/usr/bin');

      try {
        const env = (OpenAICodexProvider as any).buildCodexEnvironment() as Record<string, string> | null;

        expect(env).not.toBeNull();
        expect(env!.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env!.OPENAI_API_KEY).toBeUndefined();
        // Non-sensitive shell state still flows through
        expect(env!.AWS_PROFILE).toBe('dev');
        expect(env!.PATH).toBe('/opt/homebrew/bin:/usr/bin');
      } finally {
        if (originalAnthropic === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = originalAnthropic;
        }
        if (originalOpenAI === undefined) {
          delete process.env.OPENAI_API_KEY;
        } else {
          process.env.OPENAI_API_KEY = originalOpenAI;
        }
      }
    });
  });

  describe('Live Codex SDK integration', () => {
    const hasApiKey = !!process.env.OPENAI_API_KEY;
    const runProviderTests = process.env.RUN_AI_PROVIDER_TESTS === 'true';

    it.runIf(hasApiKey && runProviderTests)(
      'makes a real Codex SDK call and returns a valid response',
      async () => {
        const provider = new OpenAICodexProvider({
          apiKey: process.env.OPENAI_API_KEY!,
        });

        await provider.initialize({
          apiKey: process.env.OPENAI_API_KEY!,
          model: OpenAICodexProvider.getDefaultModel(),
          maxTokens: 256,
        });

        const responseChunks: any[] = [];
        for await (const chunk of provider.sendMessage(
          'What is 2 + 2? Reply with just the number.',
          undefined,
          'codex-live-test',
          [],
          process.cwd()
        )) {
          responseChunks.push(chunk);
          if (chunk.type === 'complete') {
            break;
          }
          if (chunk.type === 'error') {
            throw new Error(chunk.error || 'Codex live test failed');
          }
        }

        const textResponse = responseChunks
          .filter((chunk) => chunk.type === 'text')
          .map((chunk) => chunk.content || '')
          .join(' ');

        expect(responseChunks.some((chunk) => chunk.type === 'complete')).toBe(true);
        expect(textResponse).toContain('4');
      },
      120000
    );
  });
});
