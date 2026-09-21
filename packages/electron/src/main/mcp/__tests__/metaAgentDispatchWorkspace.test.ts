// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dispatchMetaAgentTool, setMetaAgentToolFns } from '../metaAgentServer';
import { clearWorktreeIdentityCache } from '../../utils/workspaceDetection';

/**
 * The dispatcher is where the caller's workspace spelling used to be thrown
 * away: a worktree caller was canonicalized to its parent's realpath, which is
 * a string no window and no session row is keyed by
 * (https://github.com/nimbalyst/nimbalyst/issues/1551).
 *
 * Real directories and a real symlink, because the behavior under test is
 * `realpath`'s.
 */
function createFixture() {
  const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-dispatch-ws-')));
  const realRoot = path.join(tmpRoot, 'real');
  const project = path.join(realRoot, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.symlinkSync(realRoot, path.join(tmpRoot, 'link'), 'junction');

  const aliasProject = path.join(tmpRoot, 'link', 'project');
  const worktree = path.join(tmpRoot, 'link', 'project_worktrees', 'feature');
  const registrationDir = path.join(aliasProject, '.git', 'worktrees', 'feature');
  fs.mkdirSync(registrationDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${registrationDir}\n`);
  fs.writeFileSync(path.join(registrationDir, 'gitdir'), `${path.join(worktree, '.git')}\n`);

  return { tmpRoot, aliasProject, worktree, canonical: fs.realpathSync.native(project) };
}

describe('dispatchMetaAgentTool workspace resolution (#1551)', () => {
  let fixture: ReturnType<typeof createFixture>;
  const seen: Array<{ tool: string; workspaceId: string }> = [];

  beforeEach(() => {
    clearWorktreeIdentityCache();
    seen.length = 0;
    fixture = createFixture();

    const record = (tool: string) => async (_sessionId: string, workspaceId: string) => {
      seen.push({ tool, workspaceId });
      return '{}';
    };
    setMetaAgentToolFns({
      listWorktrees: record('list_worktrees'),
      createSession: record('create_session'),
      spawnSession: record('spawn_session'),
      getSessionStatus: record('get_session_status'),
      getSessionResult: record('get_session_result'),
      listQueuedPrompts: record('list_queued_prompts'),
      sendPrompt: record('send_prompt'),
      notifyUser: record('notify_user'),
      respondToPrompt: record('respond_to_prompt'),
      listSpawnedSessions: record('list_spawned_sessions'),
    } as any);
  });

  afterEach(() => {
    clearWorktreeIdentityCache();
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  });

  it('hands a worktree caller the parent project as the user opened it, not its realpath', async () => {
    await dispatchMetaAgentTool('spawn_session', 'caller', fixture.worktree, { prompt: 'go' });

    expect(seen).toEqual([{ tool: 'spawn_session', workspaceId: fixture.aliasProject }]);
    expect(seen[0].workspaceId).not.toBe(fixture.canonical);
  });

  it('applies the same resolution to every session tool, prefix included', async () => {
    await dispatchMetaAgentTool('mcp__nimbalyst-host__create_session', 'caller', fixture.worktree, {});
    await dispatchMetaAgentTool('list_spawned_sessions', 'caller', fixture.worktree, {});
    await dispatchMetaAgentTool('get_session_status', 'caller', fixture.worktree, { sessionId: 'child' });

    expect(seen.map((call) => call.workspaceId)).toEqual([
      fixture.aliasProject,
      fixture.aliasProject,
      fixture.aliasProject,
    ]);
  });

  it('leaves a plain project caller on its own spelling', async () => {
    await dispatchMetaAgentTool('spawn_session', 'caller', fixture.aliasProject, { prompt: 'go' });

    expect(seen[0].workspaceId).toBe(fixture.aliasProject);
  });
});
