// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import type { SyncProvider, ProjectConfig } from '@nimbalyst/runtime/sync/types';
const source = vi.hoisted(() => ({ filePath: undefined as string | undefined, clearCache: vi.fn(), count: 1, missingRoots: new Set<string>() }));
vi.mock('fs', () => ({ existsSync: (root: string) => !source.missingRoots.has(root) }));
vi.mock('@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir', () => ({ resolveClaudeConfigDir: () => '/user/.claude' }));

vi.mock('../../file/WorkspaceEventBus', () => ({
  subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(),
  addGitignoreBypass: vi.fn(), removeGitignoreBypass: vi.fn(),
}));
vi.mock('../../utils/gitUtils', () => ({ getGitRemoteIdentities: async () => undefined }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => 'claude-code:opus' }));
vi.mock('../AgentWorkflowService', () => ({ getAgentWorkflowService: () => ({
  clearCache: source.clearCache, listEntries: async () => Array.from({ length: source.count }, (_, i) => ({ name: `review${i || ''}`, source: 'project', filePath: i ? source.filePath?.replace('/tool/', `/tool${i}/`) : source.filePath })),
}) }));

import * as bus from '../../file/WorkspaceEventBus';
import { projectConfigSources } from '../sync/projectConfigSources';
import { createProjectConfigSync } from '../sync/projectConfigSync';

let workspace = '';
afterEach(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); source.filePath = undefined; source.count = 1; source.missingRoots.clear(); vi.clearAllMocks(); });

it('skips absent global roots and subscribes once when a later refresh finds them', async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'mobile-config-'));
  const skillsRoot = '/user/.claude/skills';
  source.missingRoots.add(skillsRoot);
  const provider = { syncProjectConfig: vi.fn(async () => {}) } as unknown as SyncProvider;
  const sync = createProjectConfigSync({ ...projectConfigSources, getProvider: () => provider,
    getEnabledProjects: () => [workspace], isProjectEnabled: () => true, warn: vi.fn() });
  await sync.refresh();
  expect(bus.subscribe).not.toHaveBeenCalledWith(skillsRoot, expect.anything(), expect.anything());
  source.missingRoots.delete(skillsRoot);
  await sync.refresh();
  expect(bus.subscribe).toHaveBeenCalledWith(skillsRoot, expect.anything(), expect.anything());
  await sync.refresh();
  expect(vi.mocked(bus.subscribe).mock.calls.filter(([root]) => root === skillsRoot)).toHaveLength(1);
  sync.stop();
});

it('publishes disk actions at cold start and after add/edit/delete events without a renderer service', async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'mobile-config-'));
  const file = path.join(workspace, 'nimbalyst-local', 'ai-actions.md');
  await mkdir(path.dirname(file));
  await writeFile(file, '## Review\nReview the change\n');
  const send = vi.fn(async (_path: string, _config: ProjectConfig) => {});
  const provider = { syncProjectConfig: send } as unknown as SyncProvider;
  const warn = vi.fn();
  const sync = createProjectConfigSync({ ...projectConfigSources, getProvider: () => provider,
    getEnabledProjects: () => [workspace], isProjectEnabled: () => true, warn });
  await sync.refresh();
  expect(send.mock.calls.at(-1)![1]).toMatchObject({ commands: [{ name: 'review' }], actions: [{ label: 'Review', body: 'Review the change' }] });
  expect(bus.addGitignoreBypass).toHaveBeenCalledWith(workspace, file, expect.any(String));
  const listener = vi.mocked(bus.subscribe).mock.calls[0][2];
  await writeFile(file, '## Revised\nUpdated action\n');
  listener.onChange(file);
  await vi.waitFor(() => expect(send.mock.calls.at(-1)![1].actions?.[0].label).toBe('Revised'));
  const count = send.mock.calls.length;
  listener.onAdd(path.join(workspace, '.claude/commands/new.md'));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(count + 1));
  await rm(file);
  listener.onUnlink(file);
  await vi.waitFor(() => expect(send.mock.calls.at(-1)![1].actions).toBeUndefined());
  expect(warn).not.toHaveBeenCalled();
  sync.stop();
  expect(bus.removeGitignoreBypass).toHaveBeenCalledWith(workspace, file, expect.any(String));
  expect(bus.unsubscribe).toHaveBeenCalledTimes(4);
});

it('rejects unreadable action content instead of publishing an empty slice', async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'mobile-config-'));
  await mkdir(path.join(workspace, 'nimbalyst-local', 'ai-actions.md'), { recursive: true });
  await expect(projectConfigSources.discoverActions(workspace)).rejects.toMatchObject({ code: 'EISDIR' });
});

it('bounds watcher roots for 180 commands, filters unrelated edits, and only invalidates on workflow edits', async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'mobile-config-'));
  source.filePath = '/user/.claude/plugins/cache/tool/commands/review.md';
  source.count = 180;
  const send = vi.fn(async () => {});
  const provider = { syncProjectConfig: send } as unknown as SyncProvider;
  const sync = createProjectConfigSync({ ...projectConfigSources, getProvider: () => provider,
    getEnabledProjects: () => [workspace], isProjectEnabled: () => true, warn: vi.fn() });
  await sync.refresh();
  expect(bus.subscribe).toHaveBeenCalledTimes(4);
  expect(source.clearCache).not.toHaveBeenCalled();
  await sync.refresh();
  expect(source.clearCache).not.toHaveBeenCalled();
  const root = '/user/.claude/plugins';
  const subscription = vi.mocked(bus.subscribe).mock.calls.find(([subscribedRoot]) => subscribedRoot === root)!;
  expect(subscription).toBeDefined();
  expect(bus.addGitignoreBypass).toHaveBeenCalledWith(root, source.filePath, expect.any(String));
  subscription[2].onChange('/user/.claude/plugins/cache/tool/log.txt');
  expect(source.clearCache).not.toHaveBeenCalled();
  subscription[2].onChange(source.filePath);
  expect(source.clearCache).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(bus.subscribe).toHaveBeenCalledTimes(4);
  sync.stop();
  subscription[2].onChange(source.filePath);
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(3);
  expect(bus.unsubscribe).toHaveBeenCalledWith(root, expect.any(String));
});
