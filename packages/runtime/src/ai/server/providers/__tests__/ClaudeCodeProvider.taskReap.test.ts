// @vitest-environment node
/**
 * abort() must reap background sub-agent tasks (NIM-2458).
 *
 * A background Task/Bash sub-agent runs inside the SDK subprocess. abort()
 * kills that subprocess, so the task's terminal `task_notification` can never
 * arrive. If it is left `status: 'running'` in `activeTasks`, the *next* turn's
 * `result` sees hasRunningTasks() === true and defers teardown to the drain
 * loop — the session stays 'running' and its queued prompts stall until the
 * drain grace expires. Observed as a ~5 minute stall on 2026-08-04.
 */

import { describe, expect, it, vi } from 'vitest';

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

type ProviderInternals = {
  activeTasks: Map<string, { taskId: string; description: string; status: string }>;
  hasRunningTasks: () => boolean;
};

function internals(provider: ClaudeCodeProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

describe('ClaudeCodeProvider background task reaping', () => {
  it('marks tasks orphaned by abort() stopped so the next turn does not defer teardown', () => {
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);
    state.activeTasks.set('bkxaizroy', {
      taskId: 'bkxaizroy',
      description: 'Block until suite finishes',
      status: 'running',
    });
    state.activeTasks.set('done', {
      taskId: 'done',
      description: 'Already finished',
      status: 'completed',
    });

    provider.abort();

    expect(state.hasRunningTasks()).toBe(false);
    expect(state.activeTasks.get('bkxaizroy')?.status).toBe('stopped');
    // A task that already settled keeps its own terminal status.
    expect(state.activeTasks.get('done')?.status).toBe('completed');
  });
});
