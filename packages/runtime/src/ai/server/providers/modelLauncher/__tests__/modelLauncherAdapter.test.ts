// @vitest-environment node

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import path from 'path';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { invokeModelLauncher } from '../modelLauncherAdapter';
import { MODEL_LAUNCHER_PROFILES } from '../modelLauncherProfiles';

const WORKSPACE_PATH = path.join(process.cwd(), 'test-workspace');

function successfulChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => child.emit('close', 0));
  return child;
}

describe('model launcher adapter', () => {
  it('invokes the exact allowlisted alias over stdin and reads a completed audit', async () => {
    const spawnProcess = vi.fn(() => successfulChild());
    const readFile = vi.fn(async (filename: unknown) => {
      if (String(filename).endsWith('launcher.py')) return '# launcher';
      return JSON.stringify({
        schema_version: 1,
        requested: {
          model: 'deepseek-v4-pro:cloud',
          provider: 'ollama_cloud',
          task_sha256: createHash('sha256').update('review this').digest('hex'),
        },
        result: { status: 'completed', raw_response: 'verified response' },
      });
    });

    const result = await invokeModelLauncher({
      workspacePath: WORKSPACE_PATH,
      profile: MODEL_LAUNCHER_PROFILES[0],
      task: 'review this',
      effort: 'xhigh',
      sessionId: 'session/unsafe',
      deps: {
        spawnProcess: spawnProcess as never,
        readFile: readFile as never,
        randomId: () => 'fixed-id',
      },
    });

    expect(result.output).toBe('verified response');
    expect(spawnProcess).toHaveBeenCalledOnce();
    const [, args, options] = spawnProcess.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(args).toEqual(expect.arrayContaining([
      '--model', 'ollama-deepseek-pro',
      '--task-stdin',
      '--audit-id', 'nimbalyst-session-unsafe-fixed-id',
      '--effort', 'xhigh',
    ]));
    expect(args).not.toContain('--fallback');
    expect(options).toMatchObject({ cwd: WORKSPACE_PATH, windowsHide: true });
  });

  it('fails closed when the launcher audit is not completed', async () => {
    const readFile = vi.fn(async (filename: unknown) => {
      if (String(filename).endsWith('launcher.py')) return '# launcher';
      return JSON.stringify({
        schema_version: 1,
        requested: {
          model: 'deepseek-v4-flash:cloud',
          provider: 'ollama_cloud',
          task_sha256: createHash('sha256').update('review this').digest('hex'),
        },
        result: { status: 'failed', error: 'route denied' },
      });
    });

    await expect(invokeModelLauncher({
      workspacePath: WORKSPACE_PATH,
      profile: MODEL_LAUNCHER_PROFILES[1],
      task: 'review this',
      deps: {
        spawnProcess: (() => successfulChild()) as never,
        readFile: readFile as never,
        randomId: () => 'fixed-id',
      },
    })).rejects.toThrow('route denied');
  });

  it('rejects a completed audit for a different resolved model', async () => {
    const taskHash = createHash('sha256').update('review this').digest('hex');
    const readFile = vi.fn(async (filename: unknown) => {
      if (String(filename).endsWith('launcher.py')) return '# launcher';
      return JSON.stringify({
        schema_version: 1,
        requested: {
          model: 'deepseek-v4-flash:cloud',
          provider: 'ollama_cloud',
          task_sha256: taskHash,
        },
        result: { status: 'completed', raw_response: 'wrong route' },
      });
    });

    await expect(invokeModelLauncher({
      workspacePath: WORKSPACE_PATH,
      profile: MODEL_LAUNCHER_PROFILES[0],
      task: 'review this',
      deps: {
        spawnProcess: (() => successfulChild()) as never,
        readFile: readFile as never,
        randomId: () => 'fixed-id',
      },
    })).rejects.toThrow('does not match the approved route and task');
  });
});
