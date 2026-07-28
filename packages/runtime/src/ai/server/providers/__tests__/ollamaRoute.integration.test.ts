import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  isPackaged: false,
  queryCalls: [] as Array<{ prompt: unknown; options: Record<string, any> }>,
  nextChildSession: 1,
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return testState.isPackaged;
    },
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: unknown; options: Record<string, any> }) => {
    testState.queryCalls.push({ prompt, options });
    const providerSessionId =
      options.resume ?? `native-child-${testState.nextChildSession++}`;
    const iterator = (async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: providerSessionId,
      };
      yield {
        type: 'assistant',
        session_id: providerSessionId,
        message: {
          content: [{
            type: 'tool_use',
            id: `send-${providerSessionId}`,
            name: 'SendMessage',
            input: {
              recipient: 'team-lead',
              type: 'message',
              content: `native child result from ${providerSessionId}`,
              summary: 'Native child route verified',
            },
          }],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: providerSessionId,
        result: 'verified native child result',
      };
    })();
    return Object.assign(iterator, { streamInput: vi.fn() });
  }),
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { TeammateManager } from '../TeammateManager';
import { buildSdkOptions } from '../claudeCode/sdkOptionsBuilder';
import { OLLAMA_GLM_5_2_CLOUD_BACKEND_ID } from '../claudeCode/customBackends';
import { resolveClaudeCodeSessionRoute } from '../../../../../../electron/src/main/services/ai/ClaudeCodeSessionRoute';

const EXACT_ALIAS = 'claude-sonnet-4-5-20250929';
const ROUTE_CONFIG = {
  model: 'claude-code:ollama-glm-5-2-cloud',
  claudeCodeBackend: OLLAMA_GLM_5_2_CLOUD_BACKEND_ID,
};

// Independent high-risk representatives from every ambient selector family
// read by the pinned native SDK: socket, proxy, cloud provider, OAuth/host
// auth, and model/fallback selectors.
const HOSTILE_AMBIENT_ENV = {
  ANTHROPIC_UNIX_SOCKET: '\\\\.\\pipe\\hostile-anthropic',
  CLAUDE_CODE_API_BASE_URL: 'https://hostile-gateway.invalid',
  AGENT_PROXY_URL: 'https://hostile-agent-proxy.invalid',
  AGENT_PROXY_AUTH_TOKEN: 'hostile-agent-token',
  HTTPS_PROXY: 'http://hostile-proxy.invalid:8080',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_ACCESS_KEY_ID: 'hostile-aws-key',
  CLAUDE_CODE_USE_VERTEX: '1',
  GOOGLE_APPLICATION_CREDENTIALS: 'D:\\hostile-google.json',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  ANTHROPIC_FOUNDRY_AUTH_TOKEN: 'hostile-foundry-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'hostile-oauth-token',
  CLAUDE_CODE_HOST_CREDS_FILE: 'D:\\hostile-host-creds.json',
  CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR: '99',
  CLAUDE_BRIDGE_OAUTH_TOKEN: 'hostile-bridge-token',
  ANTHROPIC_IDENTITY_TOKEN: 'hostile-identity-token',
  ANTHROPIC_MODEL: 'hostile-manager-model',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'hostile-sonnet-model',
  CLAUDE_CODE_SUBAGENT_MODEL: 'hostile-child-model',
  FALLBACK_FOR_ALL_PRIMARY_MODELS: 'hostile-fallback-model',
} as const;

function makeManager(): TeammateManager {
  return new TeammateManager({
    logNonBlocking: vi.fn(),
    emit: vi.fn(),
    createPreToolUseHook: vi.fn(() => vi.fn()),
    createPostToolUseHook: vi.fn(() => vi.fn()),
    getAbortSignal: () => undefined,
    interruptWithMessage: vi.fn(async () => undefined),
    createCanUseToolHandler: vi.fn(
      () => vi.fn(async () => ({ behavior: 'allow' as const }))
    ),
  });
}

function makeBuildDeps(
  manager: TeammateManager,
  providerSessionId: string | null,
  config: Parameters<typeof buildSdkOptions>[0]['config'] = ROUTE_CONFIG
): Parameters<typeof buildSdkOptions>[0] {
  return {
    resolveModelVariant: () => EXACT_ALIAS,
    getMcpServersSnapshot: async () => ({}),
    createCanUseToolHandler: () => vi.fn(),
    toolHooksService: {
      createPreToolUseHook: () => vi.fn(),
      createPostToolUseHook: () => vi.fn(),
      createPermissionDeniedHook: () => vi.fn(),
    },
    teammateManager: manager,
    sessions: { getSessionId: () => providerSessionId },
    config,
    abortController: new AbortController(),
  };
}

async function buildPersistedRouteTurn(
  manager: TeammateManager,
  providerSessionId: string | null,
  onRead: () => void
) {
  const route = await resolveClaudeCodeSessionRoute(
    'nimbalyst-session-1',
    'claude-code:ollama-glm-5-2-cloud',
    undefined,
    async () => {
      onRead();
      return {
        id: 'nimbalyst-session-1',
        provider: 'claude-code',
        model: 'claude-code:ollama-glm-5-2-cloud',
        metadata: {},
      } as any;
    }
  );
  expect(route.backend?.id).toBe(OLLAMA_GLM_5_2_CLOUD_BACKEND_ID);
  if (!route.backend || !route.model) {
    throw new Error('Persisted Ollama route did not resolve');
  }
  return buildSdkOptions(
    makeBuildDeps(manager, providerSessionId, {
      model: route.model,
      claudeCodeBackend: route.backend.id,
    }),
    makeBuildParams()
  );
}

function makeBuildParams(): Parameters<typeof buildSdkOptions>[1] {
  return {
    message: 'Verify the exact route.',
    workspacePath: 'D:\\workspace',
    sessionId: 'nimbalyst-session-1',
    settingsEnv: { ...HOSTILE_AMBIENT_ENV },
    shellEnv: { ...HOSTILE_AMBIENT_ENV },
    systemPrompt: '',
    currentMode: undefined,
    imageContentBlocks: [],
    documentContentBlocks: [],
  };
}

async function launchNativeChild(
  manager: TeammateManager,
  resumeSessionId?: string
) {
  return (manager as any).streamTeammateOutput(
    'nimbalyst-session-1',
    'worker@route-team',
    'route-team',
    'worker',
    'Inspect one file and return evidence.',
    'general-purpose',
    'haiku',
    'blue',
    new AbortController(),
    resumeSessionId
  );
}

describe('programmatic Ollama route integration', () => {
  const originalProcessEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    testState.isPackaged = false;
    testState.queryCalls.length = 0;
    testState.nextChildSession = 1;
    originalProcessEnv.clear();
    for (const [key, value] of Object.entries(HOSTILE_AMBIENT_ENV)) {
      originalProcessEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const [key, value] of originalProcessEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('rebuilds the exact route for first, cached, and restored lead turns, then pins a native child and its resume in development', async () => {
    const manager = makeManager();
    let persistedReads = 0;
    const firstTurn = await buildPersistedRouteTurn(
      manager,
      null,
      () => { persistedReads += 1; }
    );
    const cachedTurn = await buildPersistedRouteTurn(
      manager,
      'manager-provider-session',
      () => { persistedReads += 1; }
    );

    const restoredManager = makeManager();
    const restoredTurn = await buildPersistedRouteTurn(
      restoredManager,
      'manager-provider-session',
      () => { persistedReads += 1; }
    );
    expect(persistedReads).toBe(3);

    for (const turn of [firstTurn, cachedTurn, restoredTurn]) {
      expect(turn.options.model).toBe(EXACT_ALIAS);
      expect(turn.options.env).toMatchObject({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4002',
        ANTHROPIC_AUTH_TOKEN: 'sk-nim-local-proxy',
        ANTHROPIC_MODEL: EXACT_ALIAS,
        ANTHROPIC_DEFAULT_SONNET_MODEL: EXACT_ALIAS,
        CLAUDE_CODE_SUBAGENT_MODEL: EXACT_ALIAS,
        CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
        NO_PROXY: '127.0.0.1,localhost',
      });
      for (const key of Object.keys(HOSTILE_AMBIENT_ENV)) {
        if (
          key !== 'ANTHROPIC_MODEL'
          && key !== 'ANTHROPIC_DEFAULT_SONNET_MODEL'
          && key !== 'CLAUDE_CODE_SUBAGENT_MODEL'
        ) {
          expect(turn.options.env[key]).toBeUndefined();
        }
      }
    }
    expect(firstTurn.options.resume).toBeUndefined();
    expect(cachedTurn.options.resume).toBe('manager-provider-session');
    expect(restoredTurn.options.resume).toBe('manager-provider-session');

    const firstChild = await launchNativeChild(restoredManager);
    const firstConsumedResult = restoredManager.drainNextTeammateMessage();
    const resumedChild = await launchNativeChild(
      restoredManager,
      firstChild.capturedSessionId
    );
    const resumedConsumedResult = restoredManager.drainNextTeammateMessage();

    expect(firstChild.capturedSessionId).toBe('native-child-1');
    expect(resumedChild.capturedSessionId).toBe('native-child-1');
    expect(firstConsumedResult).toMatchObject({
      content: 'native child result from native-child-1',
      summary: 'Native child route verified',
    });
    expect(resumedConsumedResult).toMatchObject({
      content: 'native child result from native-child-1',
      summary: 'Native child route verified',
    });
    expect(testState.queryCalls).toHaveLength(2);
    for (const call of testState.queryCalls) {
      expect(call.options.model).toBe(EXACT_ALIAS);
      expect(call.options.pathToClaudeCodeExecutable).toBe('/fake/claude');
      expect(call.options.env).toMatchObject({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4002',
        ANTHROPIC_AUTH_TOKEN: 'sk-nim-local-proxy',
        CLAUDE_CODE_SUBAGENT_MODEL: EXACT_ALIAS,
      });
    }
    expect(testState.queryCalls[0].options.resume).toBeUndefined();
    expect(testState.queryCalls[1].options.resume).toBe('native-child-1');

    for (const [key, value] of Object.entries(HOSTILE_AMBIENT_ENV)) {
      expect(process.env[key]).toBe(value);
    }
  });

  it('passes the same exact model, scrubbed environment, and executable to a packaged native child', async () => {
    testState.isPackaged = true;
    const manager = makeManager();
    await buildSdkOptions(makeBuildDeps(manager, null), makeBuildParams());

    await launchNativeChild(manager);

    expect(manager.packagedBuildOptions).toMatchObject({
      pathToClaudeCodeExecutable: '/fake/claude',
    });
    expect(testState.queryCalls).toHaveLength(1);
    expect(testState.queryCalls[0].options).toMatchObject({
      model: EXACT_ALIAS,
      pathToClaudeCodeExecutable: '/fake/claude',
    });
    expect(testState.queryCalls[0].options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4002',
      ANTHROPIC_AUTH_TOKEN: 'sk-nim-local-proxy',
      CLAUDE_CODE_SUBAGENT_MODEL: EXACT_ALIAS,
    });
    expect(testState.queryCalls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(testState.queryCalls[0].options.env.ANTHROPIC_UNIX_SOCKET).toBeUndefined();
    expect(testState.queryCalls[0].options.env.HTTPS_PROXY).toBeUndefined();
  });
});
