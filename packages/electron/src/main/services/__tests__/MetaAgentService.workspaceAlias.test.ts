// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * GitHub #1551 (follow-up to #1433): a project opened by a spelling that differs
 * from its on-disk path -- through a symlink, or by case on a case-insensitive
 * volume -- stores every session under the as-opened spelling, while
 * `dispatchMetaAgentTool` hands the service the canonicalized repo path
 * (`resolveProjectPath`, which realpath's a worktree's parent). The two strings
 * are then compared exactly, so `spawn_session` rejects its own parent and
 * `create_session` files the child under a workspace no window is open on.
 *
 * These tests use REAL directories and a REAL symlink, because the whole bug is
 * about what `realpath` does to a path: a fake resolver would encode the very
 * assumption under test.
 */

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    create: vi.fn(),
    updateMetadata: vi.fn(),
    get: vi.fn(),
  },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: { create: vi.fn() },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: {},
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class {
    async initialize() {}
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      if (i <= 0) throw new Error(`invalid model: ${id}`);
      return { provider: id.slice(0, i), model: id.slice(i + 1), combined: id };
    },
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));

vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));

/** Windows the service broadcasts `sessions:refresh-list` to. */
const sentToRenderer: Array<{ channel: string; payload: any }> = [];
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sentToRenderer.push({ channel, payload: payload as any });
          },
        },
      },
    ],
  },
}));

vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
// `workspaceDetection` imports this module too; give it the whole surface it
// reads so the real path-identity logic can run unmocked.
vi.mock('../../utils/store', () => ({
  getDefaultAIModel: () => null,
  getAgentPermissions: () => ({}),
  getAttachedFolders: () => [],
  getRecentItems: () => [],
  setWorkspaceTrusted: vi.fn(),
}));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
/** Worktree rows the service is allowed to find, keyed by id. */
const worktreeRows = new Map<string, any>();
const createdWorktrees: Array<{ projectPath: string; name: string }> = [];
const gitWorktreeCalls: Array<{ method: string; projectPath: string }> = [];
/** Project keys `list_worktrees` asked the store about. */
const worktreeListKeys: string[] = [];
vi.mock('../WorktreeStore', () => ({
  createWorktreeStore: () => ({
    get: async (id: string) => worktreeRows.get(id) ?? null,
    create: vi.fn(),
    getAllNames: async () => [],
    getWorktreeSessions: async () => [],
    list: async (projectPath: string) => {
      worktreeListKeys.push(projectPath);
      // The store matches on the exact project key, as the real one does.
      return [...worktreeRows.values()].filter((row) => row.projectPath === projectPath);
    },
  }),
}));
vi.mock('../GitWorktreeService', () => ({
  GitWorktreeService: class {
    getExistingWorktreeDirectories(projectPath: string) {
      gitWorktreeCalls.push({ method: 'getExistingWorktreeDirectories', projectPath });
      return [];
    }
    async getAllBranchNames(projectPath: string) {
      gitWorktreeCalls.push({ method: 'getAllBranchNames', projectPath });
      return [];
    }
    generateUniqueWorktreeName() {
      return 'swift-falcon';
    }
    async createWorktree(projectPath: string, options: { name: string }) {
      gitWorktreeCalls.push({ method: 'createWorktree', projectPath });
      createdWorktrees.push({ projectPath, name: options.name });
      return {
        id: 'wt-new',
        projectPath,
        path: path.join(projectPath, '_worktrees', options.name),
        name: options.name,
      };
    }
  },
}));

const dbQuery = vi.fn().mockResolvedValue({ rows: [{ in_flight: '0', total: '0' }] });
vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: { query: (...args: any[]) => dbQuery(...args) } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ kind: 'fake-db' }) }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: { start: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({ setMetaAgentToolFns: vi.fn() }));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: vi.fn(),
  extractUserPrompts: vi.fn(),
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { MetaAgentService } from '../MetaAgentService';
import { clearWorktreeIdentityCache, resolveProjectPath } from '../../utils/workspaceDetection';
import { setMetaAgentToolFns } from '../../mcp/metaAgentServer';

interface AliasFixture {
  tmpRoot: string;
  /** The spelling the project was opened by, and every session is stored under. */
  alias: string;
  /** What `dispatchMetaAgentTool` hands the service (canonical repo path). */
  canonical: string;
  /** The worktree the calling session runs in. */
  worktree: string;
  /** An unrelated real project, for the cross-workspace guard. */
  unrelated: string;
}

/**
 * The on-disk structure `git worktree add` leaves behind: a `.git` FILE in the
 * worktree pointing at the main repo's registration directory, and that
 * registration pointing back. `resolveWorktreeIdentity` verifies both ends, so
 * a directory-only fake would be rejected as forged.
 */
function createLinkedWorktree(mainRepoPath: string, worktreePath: string, worktreeName: string): void {
  const registrationDir = path.join(mainRepoPath, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(registrationDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${registrationDir}\n`);
  fs.writeFileSync(path.join(registrationDir, 'gitdir'), `${path.join(worktreePath, '.git')}\n`);
}

function createAliasFixture(): AliasFixture {
  const tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-meta-alias-')));
  const realRoot = path.join(tmpRoot, 'real');
  const project = path.join(realRoot, 'project');
  const unrelated = path.join(tmpRoot, 'unrelated');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(unrelated, { recursive: true });

  const link = path.join(tmpRoot, 'link');
  fs.symlinkSync(realRoot, link, 'junction');
  const alias = path.join(link, 'project');

  // The caller runs in a worktree of the project as opened (through the link);
  // that is what makes the dispatcher canonicalize and drop the alias.
  const worktree = path.join(link, 'project_worktrees', 'feature');
  createLinkedWorktree(alias, worktree, 'feature');

  return {
    tmpRoot,
    alias,
    canonical: fs.realpathSync.native(project),
    worktree,
    unrelated,
  };
}

const CHILD_PROMPT = 'do the thing';

function sessionRow(overrides: Record<string, unknown>) {
  return {
    provider: 'claude-code',
    model: 'claude-code:opus',
    agentRole: 'standard',
    sessionType: 'session',
    parentSessionId: null,
    worktreeId: null,
    ...overrides,
  } as any;
}

function createdWorkspaceIds(): string[] {
  return vi.mocked(AISessionsRepository.create).mock.calls.map(([row]) => (row as any).workspaceId);
}

describe('MetaAgentService workspace-alias resolution (#1551)', () => {
  let fixture: AliasFixture;
  let service: any;
  let aiService: {
    queuePromptForSession: ReturnType<typeof vi.fn>;
    triggerQueuedPromptProcessingForSession: ReturnType<typeof vi.fn>;
    respondToInteractivePrompt: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    clearWorktreeIdentityCache();
    sentToRenderer.length = 0;
    worktreeRows.clear();
    worktreeListKeys.length = 0;
    createdWorktrees.length = 0;
    gitWorktreeCalls.length = 0;
    dbQuery.mockClear();
    vi.mocked(AISessionsRepository.create).mockReset();
    vi.mocked(AISessionsRepository.get).mockReset();
    vi.mocked(AISessionsRepository.updateMetadata).mockReset();

    fixture = createAliasFixture();
    aiService = {
      queuePromptForSession: vi.fn(),
      triggerQueuedPromptProcessingForSession: vi.fn(),
      respondToInteractivePrompt: vi.fn().mockResolvedValue({ success: true }),
    };
    service = MetaAgentService.getInstance();
    service.aiService = aiService;
  });

  afterEach(() => {
    clearWorktreeIdentityCache();
    fs.rmSync(fixture.tmpRoot, { recursive: true, force: true });
  });

  it('the fixture really is the reported shape: two spellings of one directory', () => {
    expect(fixture.alias).not.toBe(fixture.canonical);
    expect(fs.realpathSync.native(fixture.alias)).toBe(fixture.canonical);
    // What the dispatcher passes in for a worktree-resident caller: the
    // canonical parent-repo spelling, with the as-opened alias discarded.
    expect(resolveProjectPath(fixture.worktree)).toBe(fixture.canonical);
  });

  it('spawn_session accepts a parent stored under the as-opened alias and files the child there', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'parent' ? sessionRow({ id: 'parent', title: 'Parent', workspacePath: fixture.alias }) : null,
    );

    const raw = await service.spawnSession('parent', fixture.canonical, { prompt: CHILD_PROMPT });
    const result = JSON.parse(raw);

    expect(result.sessionId).toBeTruthy();
    // Sibling mode promotes the parent into a workstream container; both that
    // container and the child must land in the workspace the window is open on.
    for (const workspaceId of createdWorkspaceIds()) {
      expect(workspaceId).toBe(fixture.alias);
    }
    expect(createdWorkspaceIds().length).toBeGreaterThan(0);
  });

  it('spawn_session isolated accepts the same parent (the guard runs before isolation is handled)', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'parent' ? sessionRow({ id: 'parent', workspacePath: fixture.alias }) : null,
    );

    const result = JSON.parse(
      await service.spawnSession('parent', fixture.canonical, { prompt: CHILD_PROMPT, isolated: true }),
    );

    expect(result.isolated).toBe(true);
    expect(result.workstreamId).toBeNull();
    expect(createdWorkspaceIds()).toEqual([fixture.alias]);
  });

  it('create_session files the child, the spawn gate, and the renderer refresh under the stored spelling', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'meta' ? sessionRow({ id: 'meta', workspacePath: fixture.alias }) : null,
    );

    await service.createChildSessionInternal('meta', fixture.canonical, { prompt: CHILD_PROMPT });

    expect(createdWorkspaceIds()).toEqual([fixture.alias]);
    // The spawn-gate aggregate counts children in the caller's workspace; asking
    // under the canonical spelling counts a different (empty) set of rows.
    expect(dbQuery.mock.calls.at(-1)?.[1]?.[0]).toBe(fixture.alias);
    // QueueDrive resolves a window from this path; no window is open on the
    // canonical spelling, which is what leaves the child deferred forever.
    const refresh = sentToRenderer.find((m) => m.channel === 'sessions:refresh-list');
    expect(refresh?.payload.workspacePath).toBe(fixture.alias);
  });

  it('drives the queued prompt against the stored spelling, so the child actually starts', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'meta' ? sessionRow({ id: 'meta', workspacePath: fixture.alias }) : null,
    );
    // Exercise the real delivery path rather than the unit-test bypass.
    service.shouldBypassChildAgentExecutionForTests = () => false;

    await service.createChildSessionInternal('meta', fixture.canonical, { prompt: CHILD_PROMPT });

    expect(aiService.triggerQueuedPromptProcessingForSession).toHaveBeenCalledWith(
      expect.any(String),
      fixture.alias,
      'meta-agent',
    );
  });

  it('still rejects a parent that belongs to a genuinely different workspace', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'parent' ? sessionRow({ id: 'parent', workspacePath: fixture.unrelated }) : null,
    );

    await expect(
      service.spawnSession('parent', fixture.canonical, { prompt: CHILD_PROMPT }),
    ).rejects.toThrow(/not found in this workspace/);
    expect(AISessionsRepository.create).not.toHaveBeenCalled();
  });

  it('still rejects a parent whose stored path merely looks like a prefix of the caller workspace', async () => {
    // `/…/real/project-sibling` shares a prefix with `/…/real/project` but is a
    // different directory; string tricks must not make it pass.
    const lookalike = `${fixture.canonical}-sibling`;
    fs.mkdirSync(lookalike, { recursive: true });
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'parent' ? sessionRow({ id: 'parent', workspacePath: lookalike }) : null,
    );

    await expect(
      service.spawnSession('parent', fixture.canonical, { prompt: CHILD_PROMPT }),
    ).rejects.toThrow(/not found in this workspace/);
  });

  it('other session tools reach a target session stored under the alias', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'target' ? sessionRow({ id: 'target', workspacePath: fixture.alias }) : null,
    );

    const result = JSON.parse(
      await service.respondToPrompt(fixture.canonical, {
        sessionId: 'target',
        promptId: 'p1',
        promptType: 'permission_request',
        response: { behavior: 'allow' },
      }),
    );

    expect(result.success).toBe(true);
    expect(aiService.respondToInteractivePrompt).toHaveBeenCalled();
  });

  it('accepts an inherited worktree whose row is filed under the stored spelling, and still rejects a foreign one', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'meta' ? sessionRow({ id: 'meta', workspacePath: fixture.alias }) : null,
    );
    worktreeRows.set('wt-own', { id: 'wt-own', projectPath: fixture.alias, path: fixture.worktree });
    worktreeRows.set('wt-foreign', { id: 'wt-foreign', projectPath: fixture.unrelated, path: fixture.unrelated });

    const result = await service.createChildSessionInternal('meta', fixture.canonical, {
      prompt: CHILD_PROMPT,
      worktreeId: 'wt-own',
    });

    expect(result.worktreeId).toBe('wt-own');
    expect(result.worktreePath).toBe(fixture.worktree);
    expect(createdWorkspaceIds()).toEqual([fixture.alias]);

    await expect(
      service.createChildSessionInternal('meta', fixture.canonical, {
        prompt: CHILD_PROMPT,
        worktreeId: 'wt-foreign',
      }),
    ).rejects.toThrow(/does not belong to this workspace/);
  });

  it('creates a NEW worktree from the stored spelling, so its project key matches the open window', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'meta' ? sessionRow({ id: 'meta', workspacePath: fixture.alias }) : null,
    );

    await service.createChildSessionInternal('meta', fixture.canonical, {
      prompt: CHILD_PROMPT,
      useWorktree: true,
    });

    expect(createdWorktrees).toEqual([{ projectPath: fixture.alias, name: 'swift-falcon' }]);
    // The name-collision scan has to look at the same checkout the worktree is
    // created in, or it can hand back a name that is already taken.
    expect(gitWorktreeCalls.map((call) => call.projectPath)).toEqual([fixture.alias, fixture.alias, fixture.alias]);
  });

  it('scopes the workspace-keyed queries behind get_session_status and list_spawned_sessions to the stored spelling', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'meta' || id === 'child'
        ? sessionRow({ id, title: 'Child', workspacePath: fixture.alias, createdAt: 1, updatedAt: 2 })
        : null,
    );
    dbQuery.mockResolvedValue({ rows: [{ id: 'child', status: 'idle', title: 'Child', provider: 'claude-code' }] });

    await service.getSessionStatusJson('child', fixture.canonical);
    expect(dbQuery.mock.calls.at(-1)?.[1]).toEqual(['child', fixture.alias]);

    dbQuery.mockResolvedValue({ rows: [] });
    await service.listSpawnedSessionsJson('meta', fixture.canonical);
    expect(dbQuery.mock.calls.at(-1)?.[1]).toEqual([fixture.alias, 'meta']);
  });

  it('lists the caller\'s worktrees through the registered tool callback, under the stored key', async () => {
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'meta' ? sessionRow({ id: 'meta', workspacePath: fixture.alias }) : null,
    );
    worktreeRows.set('wt-own', {
      id: 'wt-own',
      name: 'feature',
      projectPath: fixture.alias,
      path: fixture.worktree,
      branch: 'feature',
      createdAt: 1,
    });

    // Drive the callback the dispatcher actually calls, not the private method,
    // so a tool that drops its caller session id is caught here.
    await service.start(aiService, vi.fn());
    const toolFns = vi.mocked(setMetaAgentToolFns).mock.calls.at(-1)?.[0] as any;
    const listed = JSON.parse(await toolFns.listWorktrees('meta', fixture.canonical));

    expect(worktreeListKeys).toEqual([fixture.alias]);
    expect(listed.map((row: any) => row.id)).toEqual(['wt-own']);
  });

  it('writes the stored key back exactly, including a trailing separator', async () => {
    // An existing row spelled with a trailing separator IS the key the rest of
    // the workspace uses. Tidying it while filing a child would put the child
    // under a string nothing else matches -- the same failure as the alias, one
    // character smaller.
    const storedWithSeparator = `${fixture.alias}${path.sep}`;
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'meta' ? sessionRow({ id: 'meta', workspacePath: storedWithSeparator }) : null,
    );

    await service.createChildSessionInternal('meta', fixture.canonical, { prompt: CHILD_PROMPT });

    expect(createdWorkspaceIds()).toEqual([storedWithSeparator]);
    expect(dbQuery.mock.calls.at(-1)?.[1]?.[0]).toBe(storedWithSeparator);
    const refresh = sentToRenderer.find((m) => m.channel === 'sessions:refresh-list');
    expect(refresh?.payload.workspacePath).toBe(storedWithSeparator);
  });

  it('does not accept a parent whose worktree metadata is forged to point at the caller workspace', async () => {
    // SECURITY: an attacker-controlled directory claims to be a worktree of the
    // caller's project. Its registration does not point back at it, so the
    // filesystem refuses to confirm the equivalence and the strings stay apart.
    const forged = path.join(fixture.tmpRoot, 'forged');
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(
      path.join(forged, '.git'),
      `gitdir: ${path.join(fixture.alias, '.git', 'worktrees', 'feature')}\n`,
    );
    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'parent' ? sessionRow({ id: 'parent', workspacePath: forged }) : null,
    );

    await expect(
      service.spawnSession('parent', fixture.canonical, { prompt: CHILD_PROMPT }),
    ).rejects.toThrow(/not found in this workspace/);
  });

  it('accepts a parent stored under a case-variant spelling on a case-insensitive volume', async () => {
    const caseVariant = path.join(path.dirname(fixture.canonical), path.basename(fixture.canonical).toUpperCase());
    if (!fs.existsSync(caseVariant) || fs.realpathSync.native(caseVariant) !== fixture.canonical) {
      // Case-sensitive filesystem: the reported case-mismatch trigger cannot
      // occur here, so there is nothing to assert.
      return;
    }

    vi.mocked(AISessionsRepository.get).mockImplementation(async (id: string) =>
      id === 'parent' ? sessionRow({ id: 'parent', workspacePath: caseVariant }) : null,
    );

    const result = JSON.parse(
      await service.spawnSession('parent', fixture.canonical, { prompt: CHILD_PROMPT, isolated: true }),
    );

    expect(result.sessionId).toBeTruthy();
    expect(createdWorkspaceIds()).toEqual([caseVariant]);
  });
});
