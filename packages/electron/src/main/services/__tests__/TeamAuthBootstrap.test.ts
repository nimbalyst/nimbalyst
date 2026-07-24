import { describe, expect, it, vi } from 'vitest';

import { createTeamAuthBootstrap } from '../TeamAuthBootstrap';

describe('team auth bootstrap', () => {
  it('coalesces a re-entrant auth notification into the active bootstrap', async () => {
    let runBootstrap!: () => Promise<void>;
    let reentrantRun: Promise<void> | undefined;

    const bootstrap = vi.fn(async () => {
      await Promise.resolve();
      reentrantRun = runBootstrap();
    });
    runBootstrap = createTeamAuthBootstrap(bootstrap);

    const firstRun = runBootstrap();
    await firstRun;
    await reentrantRun;

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(reentrantRun).toBe(firstRun);
  });

  it('allows a later authenticated bootstrap after the active run settles', async () => {
    const bootstrap = vi.fn().mockResolvedValue(undefined);
    const runBootstrap = createTeamAuthBootstrap(bootstrap);

    await runBootstrap();
    await runBootstrap();

    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});
