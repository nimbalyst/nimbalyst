// @vitest-environment node
/**
 * Every path that kills a query must reap its background sub-agent tasks
 * (NIM-2458, #1269).
 *
 * A background Task/Bash sub-agent runs inside the SDK subprocess. abort()
 * kills that subprocess, so the task's terminal `task_notification` can never
 * arrive. If it is left `status: 'running'` in `activeTasks`, the *next* turn's
 * `result` sees hasRunningTasks() === true and defers teardown to the drain
 * loop — the session stays 'running' and its queued prompts stall until the
 * drain grace expires. Observed as a ~5 minute stall on 2026-08-04.
 *
 * interruptCurrentTurn() leaves the same wreckage: the streaming loop breaks on
 * the interrupt, so no terminal notification can land afterwards, and the drain
 * that would otherwise reap never runs because an interrupt is not an abort.
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
  leadQuery: unknown;
};

function seedTasks(state: ProviderInternals): void {
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
}

function internals(provider: ClaudeCodeProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

describe('ClaudeCodeProvider background task reaping', () => {
  it('marks tasks orphaned by abort() stopped so the next turn does not defer teardown', () => {
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);
    seedTasks(state);

    provider.abort();

    expect(state.hasRunningTasks()).toBe(false);
    expect(state.activeTasks.get('bkxaizroy')?.status).toBe('stopped');
    // A task that already settled keeps its own terminal status.
    expect(state.activeTasks.get('done')?.status).toBe('completed');
  });

  it('marks tasks orphaned by interruptCurrentTurn() stopped', async () => {
    const provider = new ClaudeCodeProvider();
    const state = internals(provider);
    const interrupt = vi.fn(async () => {});
    state.leadQuery = { interrupt };
    seedTasks(state);

    const outcome = await provider.interruptCurrentTurn();

    expect(outcome.method).toBe('interrupt');
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(state.hasRunningTasks()).toBe(false);
    expect(state.activeTasks.get('bkxaizroy')?.status).toBe('stopped');
    expect(state.activeTasks.get('done')?.status).toBe('completed');
  });
});
