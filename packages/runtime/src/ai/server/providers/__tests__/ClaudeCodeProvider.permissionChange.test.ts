/**
 * Mid-turn permission changes on ClaudeCodeProvider (NIM-2403).
 *
 * A turn resolves its effective session mode once and hands the derived
 * `permissionMode` to `query()` for the life of that turn. Switching the project
 * to "Allow everything" while the agent is running therefore did nothing until
 * the agent stopped — the SDK classifier kept escalating, and
 * `immediateToolDecision` deliberately refuses to let bypass-all short-circuit a
 * classifier escalation. These tests cover the push into the live query.
 */

// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider } from '../ClaudeCodeProvider';
import { BaseAgentProvider } from '../BaseAgentProvider';

type TrustStatus = {
  trusted: boolean;
  mode: 'ask' | 'allow-all' | 'bypass-all' | null;
  allowAllUsesClassifier?: boolean;
};

/** Register a provider as mid-turn with a fake live query. */
function streamingProvider(state: {
  requestedMode: 'planning' | 'agent' | 'auto';
  currentMode: 'planning' | 'agent' | 'auto';
  setPermissionMode?: (mode: string) => Promise<void>;
}) {
  const setPermissionMode = vi.fn(state.setPermissionMode ?? (async () => {}));
  const provider = new ClaudeCodeProvider();
  Object.assign(provider as unknown as Record<string, unknown>, {
    requestedMode: state.requestedMode,
    currentMode: state.currentMode,
    pathForTrust: '/proj',
    leadQuery: { setPermissionMode },
  });
  (ClaudeCodeProvider as unknown as { streamingInstances: Set<unknown> }).streamingInstances.add(provider);
  return { provider, setPermissionMode };
}

const modeOf = (provider: ClaudeCodeProvider) =>
  (provider as unknown as { currentMode?: string }).currentMode;

function trustIs(status: TrustStatus) {
  ClaudeCodeProvider.setTrustChecker(() => status);
}

describe('ClaudeCodeProvider mid-turn permission changes', () => {
  afterEach(() => {
    (ClaudeCodeProvider as unknown as { streamingInstances: Set<unknown> }).streamingInstances.clear();
    BaseAgentProvider.setTrustChecker(null);
    vi.restoreAllMocks();
  });

  it('drops a turn out of classifier mode when the project switches to Allow everything', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'auto',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalledWith('default');
    expect(modeOf(provider)).toBe('agent');
  });

  it('turns the classifier on mid-turn when the project switches to Agent-verified', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'agent',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: true });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalledWith('auto');
    expect(modeOf(provider)).toBe('auto');
  });

  it('leaves an explicitly-requested auto session alone', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'auto',
      currentMode: 'auto',
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(modeOf(provider)).toBe('auto');
  });

  it('does not touch the SDK when the effective mode is unchanged', async () => {
    const { setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'agent',
    });
    trustIs({ trusted: true, mode: 'ask', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it('rolls the tracked mode back when the SDK call fails on a dead transport', async () => {
    const { provider, setPermissionMode } = streamingProvider({
      requestedMode: 'agent',
      currentMode: 'auto',
      setPermissionMode: async () => {
        throw new Error('transport closed');
      },
    });
    trustIs({ trusted: true, mode: 'bypass-all', allowAllUsesClassifier: false });

    await ClaudeCodeProvider.applyPermissionChange();

    expect(setPermissionMode).toHaveBeenCalled();
    // canUseTool must keep honouring the mode the turn actually runs under.
    expect(modeOf(provider)).toBe('auto');
  });
});
