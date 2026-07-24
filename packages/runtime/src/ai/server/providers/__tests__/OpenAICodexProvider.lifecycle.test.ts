import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICodexProvider } from '../OpenAICodexProvider';
import { configureMcpServers } from '../../services/mcpServerConfig';

interface ManualTimerHandle {
  dueAt: number;
  callback: () => void;
  unref: ReturnType<typeof vi.fn>;
}

class ManualIdleScheduler {
  private now = 0;
  private readonly handles = new Set<ManualTimerHandle>();
  readonly setTimeout = vi.fn((callback: () => void, delayMs: number) => {
    const handle: ManualTimerHandle = {
      dueAt: this.now + delayMs,
      callback,
      unref: vi.fn(),
    };
    this.handles.add(handle);
    return handle as never;
  });
  readonly clearTimeout = vi.fn((handle: ManualTimerHandle) => {
    this.handles.delete(handle);
  });

  advanceBy(delayMs: number): void {
    this.now += delayMs;
    const due = [...this.handles]
      .filter((handle) => handle.dueAt <= this.now)
      .sort((a, b) => a.dueAt - b.dueAt);
    for (const handle of due) {
      if (!this.handles.delete(handle)) continue;
      handle.callback();
    }
  }

  get lastHandle(): ManualTimerHandle | undefined {
    return [...this.handles].at(-1);
  }
}

function completeEventStream(beforeComplete?: () => Promise<void>) {
  return {
    async *[Symbol.asyncIterator]() {
      if (beforeComplete) await beforeComplete();
      yield {
        type: 'complete',
        content: 'ok',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    },
  };
}

async function drainTurn(provider: OpenAICodexProvider, message: string): Promise<void> {
  for await (const _chunk of provider.sendMessage(
    message,
    undefined,
    'session-lifecycle',
    [],
    process.cwd(),
  )) {
    // drain
  }
}

function createHarness(options: {
  idleTimeoutMs?: number;
  beforeSecondTurnCompletes?: () => Promise<void>;
  beforeTurnCompletes?: (turnCount: number) => Promise<void> | undefined;
} = {}) {
  const idleScheduler = new ManualIdleScheduler();
  const protocolSession = {
    id: 'thread-retained',
    platform: 'codex-app-server',
    raw: { fake: true },
  };
  const createSession = vi.fn(async () => protocolSession);
  const resumeSession = vi.fn(async () => protocolSession);
  const cleanupSession = vi.fn();
  let turnCount = 0;
  const sendMessage = vi.fn(() => {
    turnCount++;
    const turnGate = options.beforeTurnCompletes?.(turnCount);
    return completeEventStream(
      turnGate
        ? async () => turnGate
        : (turnCount === 2 ? options.beforeSecondTurnCompletes : undefined),
    );
  });
  const protocol = {
    platform: 'codex-app-server',
    createSession,
    resumeSession,
    forkSession: vi.fn(),
    sendMessage,
    abortSession: vi.fn(),
    cleanupSession,
  } as never;

  const provider = new OpenAICodexProvider(
    { apiKey: 'test-key' },
    {
      transport: 'app-server',
      protocol,
      idleProtocolSessionTimeoutMs: options.idleTimeoutMs ?? 1_000,
      idleProtocolSessionScheduler: idleScheduler,
    } as never,
  );

  return {
    provider,
    createSession,
    resumeSession,
    sendMessage,
    cleanupSession,
    protocolSession,
    idleScheduler,
  };
}

describe('OpenAICodexProvider app-server lifecycle retention', () => {
  beforeEach(() => {
    configureMcpServers({ mcpServerPort: null, extensionDevServerPort: null });
    OpenAICodexProvider.setTrustChecker(() => ({ trusted: true, mode: 'allow-all' }));
    OpenAICodexProvider.setPermissionPatternChecker(async () => false);
    OpenAICodexProvider.setPermissionPatternSaver(async () => {});
    OpenAICodexProvider.setSecurityLogger(() => {});
    OpenAICodexProvider.setCodexAuthGate(null);
  });

  afterEach(() => {
    configureMcpServers({ mcpServerPort: null, extensionDevServerPort: null });
  });

  it('evicts an idle app-server child while preserving the thread id for resume', async () => {
    const h = createHarness();
    await h.provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5' });

    try {
      await drainTurn(h.provider, 'first');

      expect(h.idleScheduler.lastHandle).toBeDefined();
      expect(h.idleScheduler.lastHandle!.unref).toHaveBeenCalledTimes(1);
      h.idleScheduler.advanceBy(999);
      expect(h.cleanupSession).not.toHaveBeenCalled();
      h.idleScheduler.advanceBy(1);
      expect(h.cleanupSession).toHaveBeenCalledTimes(1);
      expect(h.cleanupSession).toHaveBeenCalledWith(h.protocolSession);

      await drainTurn(h.provider, 'resume after idle eviction');
      expect(h.createSession).toHaveBeenCalledTimes(1);
      expect(h.resumeSession).toHaveBeenCalledTimes(1);
      expect(h.resumeSession).toHaveBeenCalledWith(
        'thread-retained',
        expect.any(Object),
      );
    } finally {
      h.provider.destroy();
    }
  });

  it('cancels and restarts the idle deadline when a new turn arrives', async () => {
    const h = createHarness();
    await h.provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5' });

    try {
      await drainTurn(h.provider, 'first');
      h.idleScheduler.advanceBy(500);

      await drainTurn(h.provider, 'second');
      h.idleScheduler.advanceBy(500);
      expect(h.cleanupSession).not.toHaveBeenCalled();

      h.idleScheduler.advanceBy(500);
      expect(h.cleanupSession).toHaveBeenCalledTimes(1);
    } finally {
      h.provider.destroy();
    }
  });

  it('never evicts a child while its next turn is active', async () => {
    let releaseSecondTurn!: () => void;
    let markSecondTurnStarted!: () => void;
    const secondTurnStarted = new Promise<void>((resolve) => {
      markSecondTurnStarted = resolve;
    });
    const secondTurnGate = new Promise<void>((resolve) => {
      releaseSecondTurn = resolve;
    });
    const h = createHarness({
      beforeSecondTurnCompletes: async () => {
        markSecondTurnStarted();
        await secondTurnGate;
      },
    });
    await h.provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5' });

    try {
      await drainTurn(h.provider, 'first');
      h.idleScheduler.advanceBy(500);

      const activeTurn = drainTurn(h.provider, 'long second turn');
      await secondTurnStarted;
      h.idleScheduler.advanceBy(5_000);
      expect(h.cleanupSession).not.toHaveBeenCalled();

      releaseSecondTurn();
      await activeTurn;
      h.idleScheduler.advanceBy(999);
      expect(h.cleanupSession).not.toHaveBeenCalled();
      h.idleScheduler.advanceBy(1);
      expect(h.cleanupSession).toHaveBeenCalledTimes(1);
    } finally {
      h.provider.destroy();
    }
  });

  it('does not arm idle eviction until every overlapping turn has settled', async () => {
    let releaseSecondTurn!: () => void;
    let releaseThirdTurn!: () => void;
    const secondTurnGate = new Promise<void>((resolve) => {
      releaseSecondTurn = resolve;
    });
    const thirdTurnGate = new Promise<void>((resolve) => {
      releaseThirdTurn = resolve;
    });
    let activeTurnsStarted = 0;
    let markBothTurnsStarted!: () => void;
    const bothTurnsStarted = new Promise<void>((resolve) => {
      markBothTurnsStarted = resolve;
    });
    const h = createHarness({
      beforeTurnCompletes: (turnCount) => {
        if (turnCount < 2) return undefined;
        activeTurnsStarted++;
        if (activeTurnsStarted === 2) markBothTurnsStarted();
        return turnCount === 2 ? secondTurnGate : thirdTurnGate;
      },
    });
    await h.provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5' });

    try {
      await drainTurn(h.provider, 'establish cached child');

      const secondTurn = drainTurn(h.provider, 'overlap one');
      const thirdTurn = drainTurn(h.provider, 'overlap two');
      await bothTurnsStarted;

      releaseSecondTurn();
      await secondTurn;
      h.idleScheduler.advanceBy(5_000);
      expect(h.cleanupSession).not.toHaveBeenCalled();

      releaseThirdTurn();
      await thirdTurn;
      h.idleScheduler.advanceBy(999);
      expect(h.cleanupSession).not.toHaveBeenCalled();
      h.idleScheduler.advanceBy(1);
      expect(h.cleanupSession).toHaveBeenCalledTimes(1);
    } finally {
      h.provider.destroy();
    }
  });

  it('clears the pending idle deadline during provider destruction', async () => {
    const h = createHarness();
    await h.provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-5' });

    await drainTurn(h.provider, 'first');
    h.provider.destroy();
    expect(h.cleanupSession).toHaveBeenCalledTimes(1);

    h.idleScheduler.advanceBy(5_000);
    expect(h.cleanupSession).toHaveBeenCalledTimes(1);
  });
});
