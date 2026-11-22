// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  observed: new Map<string, (event: string, file: string, at: number) => void>(),
  policySessions: [] as string[],
}));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({ SessionFilesRepository: { addFileLink: vi.fn(async () => {}) } }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ OpenAICodexProvider: { setShellTrackingHost: vi.fn() } }));
vi.mock('../../../utils/appPaths', () => ({ getPackageRoot: () => '/nonexistent' }));
vi.mock('../../../file/WorkspaceEventBus', () => ({
  subscribe: async (workspace: string, _id: string, callbacks: any) => {
    fixture.observed.set(workspace, callbacks.onObserved);
    callbacks.onHealthChanged({ state: 'watching' });
  },
  unsubscribe: vi.fn(), getSubscriberIds: (workspace: string) => ['shell-hooks:' + workspace], drainWorkspaceEvents: async () => {},
}));
vi.mock('../../../utils/fileFilters', () => ({ shouldExcludePath: () => false }));
vi.mock('../../WorkspaceFileAttributionPolicy', () => ({ workspaceFileAttributionPolicy: { getSessionIds: () => fixture.policySessions } }));
vi.mock('../../SessionEditQuota', () => ({ sessionEditQuota: { tryReserve: async () => true } }));
vi.mock('../../sessionFilesNotify', () => ({ notifySessionFilesUpdated: vi.fn() }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } } }));
const checkout = vi.hoisted(() => ({ prepare: async (): Promise<any> => undefined }));
vi.mock('../ShellCheckoutBaseline', () => ({ prepareShellCheckoutBaseline: () => checkout.prepare() }));
vi.mock('../shellCoverageStore', () => ({ createShellCoverageStore: () => ({ load: async () => undefined, save: async () => {} }) }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: {} }));
vi.mock('../../../HistoryManager', () => ({ historyManager: { getPendingTags: vi.fn(async () => []), createTag: vi.fn(async () => {}) } }));

import { SessionFilesRepository } from '@nimbalyst/runtime/storage/repositories/SessionFilesRepository';
import {
  claudeShellEndTurn,
  claudeShellPost,
  claudeShellPre,
  takeClaudeShellAttributedFiles,
} from '@nimbalyst/runtime/ai/server/claudeShellTracking';
import { configureClaudeShellTracking, registerClaudeShellSession, releaseClaudeShellSession } from '../claudeShellTrackingHost';
import { shellFileAttribution, shellTrackingCoverage } from '../codexShellTrackingHost';
import { shellBeforeContentLedger } from '../shellBeforeContentLedger';
import { workspaceAttributionThrottle } from '../../WorkspaceAttributionThrottle';
import { historyManager } from '../../../HistoryManager';
import { agentToolActivity } from '@nimbalyst/runtime/ai/server/agentToolActivity';

let workspace: string;
const sessions: string[] = [];
const addFileLink = vi.mocked(SessionFilesRepository.addFileLink);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-shell-')));
  fixture.policySessions = [];
  checkout.prepare = async () => undefined;
  addFileLink.mockClear();
  configureClaudeShellTracking();
});
afterEach(async () => {
  for (const id of sessions.splice(0)) {
    claudeShellEndTurn(id);
    await releaseClaudeShellSession(id);
  }
  await fs.rm(workspace, { recursive: true, force: true });
});

async function register(sessionId: string) {
  sessions.push(sessionId);
  await registerClaudeShellSession(sessionId, workspace);
}

/** A heredoc edit that names the file only as a bare basename, run from a persisted cwd. */
async function heredocEdit(sessionId: string, toolUseId: string, file: string) {
  await claudeShellPre(sessionId, toolUseId, { command: `python3 - <<'EOF'\np='${path.basename(file)}'\nopen(p,'w').write('x')\nEOF` });
  await pause(5);
  await fs.writeFile(file, `edited by ${toolUseId}`);
  fixture.observed.get(workspace)!('change', file, Date.now());
  claudeShellPost(sessionId, toolUseId);
  return takeClaudeShellAttributedFiles(sessionId);
}

it('links a file a Bash heredoc wrote even though the command never names its path', async () => {
  await register('claude-a');
  const file = path.join(workspace, 'SQLiteDatabaseProxy.ts');
  await fs.writeFile(file, 'before');

  const attributed = await heredocEdit('claude-a', 'bash-1', file);

  expect(addFileLink).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'claude-a',
    filePath: file,
    linkType: 'edited',
    metadata: expect.objectContaining({ toolUseId: 'bash-1', attribution: expect.objectContaining({ method: 'shell-hook-window' }) }),
  }));
  // The turn-end history snapshot list comes from what was linked, not from command text.
  expect(attributed).toEqual([file]);
});

it('still links while a Codex app-server turn is running in the same checkout', async () => {
  // The Codex session is live and registered with the shared tracker, but has no command running.
  const codexGeneration = await shellFileAttribution.register('codex-b', workspace);
  fixture.policySessions = ['codex-b'];
  try {
    await register('claude-a');
    const file = path.join(workspace, 'proxy.ts');
    await fs.writeFile(file, 'before');
    await heredocEdit('claude-a', 'bash-1', file);
    expect(addFileLink).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'claude-a', filePath: file }));
  } finally {
    await shellFileAttribution.release(codexGeneration);
  }
});

it('abstains with a withheld-edit reason when two sessions have Bash windows open', async () => {
  await register('claude-a');
  await register('claude-b');
  const file = path.join(workspace, 'shared.ts');
  await fs.writeFile(file, 'before');
  await claudeShellPre('claude-b', 'long-test-run', { command: 'pnpm test' });

  await heredocEdit('claude-a', 'bash-1', file);
  claudeShellPost('claude-b', 'long-test-run');
  await takeClaudeShellAttributedFiles('claude-b');

  expect(addFileLink).not.toHaveBeenCalled();
  const [a, b] = await shellTrackingCoverage.readMany(['claude-a', 'claude-b']);
  expect(a.reasons.competingOwners).toBeGreaterThan(0);
  expect(b.reasons.competingOwners).toBeGreaterThan(0);
});

it("does not spend this session's attribution budget on another session's burst", async () => {
  await register('claude-a');
  // Frozen clock: a sustained build keeps every budget it touches empty for the whole command.
  const frozen = Date.now();
  workspaceAttributionThrottle.resetForTesting(() => frozen);
  try {
    // A build in another session floods both the workspace-wide watcher budget and its own.
    for (let i = 0; i < 40; i++) {
      workspaceAttributionThrottle.tryAcquire(workspace);
      workspaceAttributionThrottle.tryAcquire('session:noisy-build-session');
    }
    const file = path.join(workspace, 'edit.ts');
    await fs.writeFile(file, 'before');
    await heredocEdit('claude-a', 'bash-1', file);
    expect(addFileLink).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'claude-a', filePath: file }));
  } finally {
    workspaceAttributionThrottle.resetForTesting();
  }
});

it('keeps a backgrounded command window open after its acknowledgement', async () => {
  await register('claude-a');
  const file = path.join(workspace, 'generated.ts');
  await claudeShellPre('claude-a', 'bg-1', { command: './codegen.sh', run_in_background: true });
  claudeShellPost('claude-a', 'bg-1');
  await takeClaudeShellAttributedFiles('claude-a');
  await pause(5);
  await fs.writeFile(file, 'generated');
  fixture.observed.get(workspace)!('add', file, Date.now());
  expect(await takeClaudeShellAttributedFiles('claude-a')).toEqual([file]);
});

it('tags the link with the content the file held before the window', async () => {
  await register('claude-a');
  const file = path.join(workspace, 'dirty.ts');
  await fs.writeFile(file, 'uncommitted work');
  await claudeShellPre('claude-a', 'bash-1', { command: 'python3 edit.py' });
  await pause(5);
  await fs.writeFile(file, 'after');
  // The session's own watcher reports what its cache held just before the change.
  shellBeforeContentLedger.record('claude-a', file, 'uncommitted work', Date.now());
  fixture.observed.get(workspace)!('change', file, Date.now());
  claudeShellPost('claude-a', 'bash-1');
  await takeClaudeShellAttributedFiles('claude-a');
  expect(historyManager.createTag).toHaveBeenCalledWith(workspace, file, 'ai-edit-pending-claude-a-bash-1', 'uncommitted work', 'claude-a', 'bash-1', { speculative: true });
});

// Claude registers the whole session but opens tracker windows only for Bash,
// so another Claude session's Edit must still count as that session's write.
it("does not link another Claude session's Edit to this session's Bash", async () => {
  await register('claude-a');
  await register('claude-b');
  agentToolActivity.declare('claude-b', workspace);
  const file = path.join(workspace, 'edited-by-b.ts');
  await fs.writeFile(file, 'before');
  await claudeShellPre('claude-a', 'bash-1', { command: 'pnpm test' });
  agentToolActivity.started('claude-b', 'edit-1', 'Edit', { file_path: file });
  await pause(5);
  await fs.writeFile(file, 'written by B');
  fixture.observed.get(workspace)!('change', file, Date.now());
  agentToolActivity.finished('claude-b', 'edit-1');
  claudeShellPost('claude-a', 'bash-1');
  await takeClaudeShellAttributedFiles('claude-a');
  expect(addFileLink).not.toHaveBeenCalled();
});

// An interrupt can end the turn while a pre hook is still capturing its baseline.
it('does not install a window when the turn ends during baseline capture', async () => {
  await register('claude-a');
  let finishCapture!: () => void;
  checkout.prepare = () => new Promise((resolve) => { finishCapture = () => resolve(undefined); });
  const pre = claudeShellPre('claude-a', 'interrupted', { command: 'python3 edit.py' });
  await vi.waitFor(() => expect(finishCapture).toBeDefined());
  await claudeShellEndTurn('claude-a');
  finishCapture();
  await pre;
  expect(shellFileAttribution.getStats().activeWindows).toBe(0);
});

it('closes a backgrounded command whose launch failed', async () => {
  await register('claude-a');
  await claudeShellPre('claude-a', 'bg-denied', { command: './server.sh', run_in_background: true });
  expect(shellFileAttribution.getStats().activeWindows).toBe(1);
  claudeShellPost('claude-a', 'bg-denied', { failed: true });
  await takeClaudeShellAttributedFiles('claude-a');
  expect(shellFileAttribution.getStats().activeWindows).toBe(0);
});

// In a Git checkout every candidate waits for its window to close. A
// background window closes at turn end, so its links exist only after that.
it('persists a backgrounded command\'s checkout-deferred edits when the turn ends', async () => {
  checkout.prepare = async () => ({
    defer: async () => true,
    finish: async (candidates: Array<{ filePath: string }>) => new Map(candidates.map((c) => [c.filePath, 'edit'])),
  });
  await register('claude-a');
  const file = path.join(workspace, 'background-output.ts');
  await claudeShellPre('claude-a', 'bg-1', { command: './codegen.sh', run_in_background: true });
  claudeShellPost('claude-a', 'bg-1');
  await pause(5);
  await fs.writeFile(file, 'generated');
  fixture.observed.get(workspace)!('add', file, Date.now());
  expect(await takeClaudeShellAttributedFiles('claude-a')).toEqual([]);
  await claudeShellEndTurn('claude-a');
  expect(await takeClaudeShellAttributedFiles('claude-a')).toEqual([file]);
});
