// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ observed: undefined as undefined | ((event: string, file: string, at: number) => void) }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({ SessionFilesRepository: { addFileLink: vi.fn() } }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ OpenAICodexProvider: { setShellTrackingHost: vi.fn() } }));
vi.mock('../../../utils/appPaths', () => ({ getPackageRoot: () => path.resolve('packages/electron') }));
vi.mock('../../../file/WorkspaceEventBus', () => ({
  subscribe: async (_workspace: string, _id: string, callbacks: any) => {
    fixture.observed = callbacks.onObserved;
    callbacks.onHealthChanged({ state: 'watching' });
  },
  unsubscribe: vi.fn(), getSubscriberIds: (workspace: string) => ['shell-hooks:' + workspace], drainWorkspaceEvents: async () => {},
}));
vi.mock('../../../file/knownFileWrites', () => ({ contentFingerprint: () => 'fingerprint', isKnownFileWrite: () => false }));
vi.mock('../../../utils/fileFilters', () => ({ shouldExcludePath: () => true }));
vi.mock('../../WorkspaceFileAttributionPolicy', () => ({ workspaceFileAttributionPolicy: { getSessionIds: () => [] } }));
vi.mock('../../SessionEditQuota', () => ({ sessionEditQuota: { tryReserve: async () => true } }));
vi.mock('../../WorkspaceAttributionThrottle', () => ({ workspaceAttributionThrottle: { tryAcquire: () => true } }));
vi.mock('../../sessionFilesNotify', () => ({ notifySessionFilesUpdated: vi.fn() }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn: vi.fn(), debug: vi.fn() } } }));
vi.mock('../ShellCheckoutBaseline', () => ({ prepareShellCheckoutBaseline: async () => undefined }));
vi.mock('../shellCoverageStore', () => ({ createShellCoverageStore: () => ({ load: async () => undefined, save: async () => {} }) }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: {} }));

import { prepareShellTracking, shellFileAttribution, shellTrackingCoverage } from '../codexShellTrackingHost';

let registration: Awaited<ReturnType<typeof prepareShellTracking>>;
afterEach(async () => {
  registration?.dispose();
  await shellFileAttribution.drain(['host-test']);
  await shellTrackingCoverage.flush(['host-test']);
  vi.restoreAllMocks();
});

it('fences foreign identity through the executable hook and loopback host without a coverage fault', async () => {
  registration = await prepareShellTracking('host-test', '/workspace');
  registration!.turnStarted('root-turn');
  const pre = vi.spyOn(shellFileAttribution, 'pre');
  const post = vi.spyOn(shellFileAttribution, 'post');
  const hook = (event: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('packages/electron/resources/codex-shell-hook.cjs')], {
      env: { ...process.env, ...registration!.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Hook exited ${code}`)));
    child.stdin.end(JSON.stringify({ hook_event_name: event, tool_use_id: 'foreign', tool_name: 'Bash', session_id: 'child-session', turn_id: 'child-turn', agent_type: 'worker', tool_input: { command: 'private command' } }));
  });
  await hook('PreToolUse');
  expect(pre).toHaveBeenCalledWith(expect.any(String), 'foreign', 'Bash', { sessionId: 'child-session', turnId: 'child-turn', agentType: 'worker' }, 'private command');
  expect(shellFileAttribution.getStats().activeWindows).toBe(0);
  fixture.observed!('change', '/workspace/excluded.ts', Date.now() + 1);
  await shellFileAttribution.flush();
  await hook('PostToolUse');
  registration!.endTurn();
  const [coverage] = await shellTrackingCoverage.readMany(['host-test']);
  expect(coverage.events).toContainEqual(expect.objectContaining({ reason: 'foreignTool', tool: 'Bash', hookTurnId: 'child-turn', turnMatched: false, agentType: 'worker', hookSessionId: 'child-session' }));
  expect(coverage.reasons).toEqual({ foreignTool: 2 });
  expect(coverage.state).toBe('no-detected-fault');
  expect(post).toHaveBeenCalledWith(expect.any(String), 'foreign', { sessionId: 'child-session', turnId: 'child-turn', agentType: 'worker', tool: 'Bash' });
});

it('accepts legacy hooks and rejects invalid optional identities at the HTTP boundary', async () => {
  registration = await prepareShellTracking('validation-test', '/workspace');
  const send = (fields: Record<string, unknown>) => fetch(registration!.env.NIMBALYST_SHELL_HOOK_URL, {
    method: 'POST', body: JSON.stringify({ event: 'PreToolUse', id: 'legacy', tool: 'Bash', ...fields }),
  });
  expect((await send({})).status).toBe(200);
  const pre = vi.spyOn(shellFileAttribution, 'pre');
  const command = '界'.repeat(2000);
  expect((await send({ command })).status).toBe(200);
  expect(pre).toHaveBeenLastCalledWith(expect.any(String), 'legacy', 'Bash', expect.any(Object), command);
  expect((await send({ command: '\u0001'.repeat(1000) })).status).toBe(200); // Escaped JSON exceeds the old 4 KiB cap.
  expect((await send({ command: 1 })).status).toBe(400);
  expect((await send({ command: 'x'.repeat(2001) })).status).toBe(400);
  expect((await send({ ignored: 'x'.repeat(8192) })).status).toBe(413);
  for (const field of ['session_id', 'turn_id', 'agent_type']) {
    expect((await send({ [field]: 1 })).status).toBe(400);
    expect((await send({ [field]: 'x'.repeat(257) })).status).toBe(400);
  }
  await shellTrackingCoverage.flush(['validation-test']);
});

it('forwards only bounded Bash commands through the executable hook', async () => {
  registration = await prepareShellTracking('command-test', '/workspace');
  const pre = vi.spyOn(shellFileAttribution, 'pre');
  for (const [tool, command, expected] of [
    ['Bash', 'x'.repeat(2100), 'x'.repeat(2000)],
    ['Bash', ['printf', 'hello', './named.ts'], 'printf hello ./named.ts'],
    ['Bash', 42, undefined],
    ['mcp__test', 'not a shell command', undefined],
  ] as const) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('packages/electron/resources/codex-shell-hook.cjs')], {
        env: { ...process.env, ...registration!.env }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Hook exited ${code}`)));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_use_id: 'command', tool_name: tool, tool_input: { command, ignored: 'x'.repeat(10_000) } }));
    });
    expect(pre).toHaveBeenLastCalledWith(expect.any(String), 'command', tool, expect.any(Object), expected);
  }
});

it('passes MCP start typing to attribution without marking a pending writer', async () => {
  registration = await prepareShellTracking('mcp-test', '/workspace');
  registration!.turnStarted('question-turn');
  const activity = vi.spyOn(shellTrackingCoverage, 'tool');
  registration!.toolStarted('question', 'mcp');
  expect(activity).not.toHaveBeenCalled();
  registration!.endTurn();
  await shellFileAttribution.drain(['mcp-test']);
  const [coverage] = await shellTrackingCoverage.readMany(['mcp-test']);
  expect(coverage.reasons).toEqual({});
});
