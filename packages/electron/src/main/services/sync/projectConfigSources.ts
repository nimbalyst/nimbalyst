import * as path from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import * as workspaceEventBus from '../../file/WorkspaceEventBus';
import { getGitRemoteIdentities } from '../../utils/gitUtils';
import { getDefaultAIModel } from '../../utils/store';
import { getAgentWorkflowService } from '../AgentWorkflowService';
import { parseActionPromptsFile } from '../ActionPromptParser';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';
import type { ProjectConfigSyncDependencies } from './projectConfigSync';

interface SourceWatch {
  active: boolean;
  subscriberId: string;
  roots: Set<string>;
  files: Map<string, string>;
  refresh(): Promise<void>;
}
const watches = new Map<string, SourceWatch>();
let nextWatchId = 0;

function watchCommandFiles(files: Array<string | undefined>, watch: SourceWatch | undefined): void {
  if (!watch?.active) return;
  for (const file of files) {
    if (!file || watch.files.has(file) || !watch.active) continue;
    const root = [...watch.roots].find(root => file.startsWith(`${root}${path.sep}`));
    if (!root) continue;
    watch.files.set(file, root);
    workspaceEventBus.addGitignoreBypass(root, file, watch.subscriberId);
  }
}

/** Main-process discovery and watcher ownership, with no renderer input. */
export const projectConfigSources: Pick<ProjectConfigSyncDependencies, 'discoverCommands' | 'discoverActions' | 'getGitRemoteHash' | 'subscribeChanges' | 'refreshWatchers'> = {
  refreshWatchers: workspacePath => watches.get(workspacePath)?.refresh() ?? Promise.resolve(),
  discoverCommands: async workspacePath => {
    const watch = watches.get(workspacePath);
    const service = getAgentWorkflowService(workspacePath);
    const commands = await service.listEntries({ provider: getDefaultAIModel()?.split(':')[0] || 'claude-code' });
    // Only register gitignore bypasses here; bounded watcher setup is independent
    // of the publish path and never scales with the number of command files.
    watchCommandFiles(commands.map(command => command.filePath), watch);
    return commands;
  },
  discoverActions: async workspacePath => {
    try {
      return parseActionPromptsFile(await readFile(path.join(workspacePath, 'nimbalyst-local/ai-actions.md'), 'utf8')).actions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // Let the sync owner log the project and retry; unreadable is not empty.
      throw error;
    }
  },
  getGitRemoteHash: async workspacePath => {
    const remote = await getGitRemoteIdentities(workspacePath);
    return remote ? createHash('sha256').update(remote.canonical).digest('hex') : undefined;
  },
  subscribeChanges: async (workspacePath, changed) => {
    const subscriberId = `mobile-project-config:${workspacePath}:${++nextWatchId}`;
    const actionFile = path.join(workspacePath, 'nimbalyst-local/ai-actions.md');
    const claudeRoot = resolveClaudeConfigDir();
    // The workspace bus is already shared with the file tree and covers both
    // .claude and ai-actions.md. Global roots are shared across enabled projects.
    const candidates = new Set([workspacePath, ...['commands', 'skills', 'plugins'].map(dir => path.join(claudeRoot, dir))]);
    const roots = new Set<string>();
    const watch: SourceWatch = { active: true, subscriberId, roots, files: new Map([[actionFile, workspacePath]]), refresh: refreshRoots };
    watches.set(workspacePath, watch);
    const dispose = () => {
      watch.active = false;
      if (watches.get(workspacePath) === watch) watches.delete(workspacePath);
      for (const [file, root] of watch.files) workspaceEventBus.removeGitignoreBypass(root, file, subscriberId);
      for (const root of watch.roots) workspaceEventBus.unsubscribe(root, subscriberId);
    };
    async function refreshRoots(): Promise<void> {
      if (!watch.active) return;
      const additions = [...candidates].filter(root => !roots.has(root) && (root === workspacePath || existsSync(root)));
      await Promise.all(additions.map(async root => {
        // Mark before awaiting so overlapping refreshes never duplicate a subscription.
        roots.add(root);
        const handle = (filePath: string) => {
          if (!watch.active) return;
          const relative = path.relative(root === workspacePath ? workspacePath : claudeRoot, filePath).split(path.sep).join('/');
          const commandPath = root === workspacePath ? relative.replace(/^\.claude\//, '') : relative;
          const isCommand = (root !== workspacePath || relative.startsWith('.claude/')) && /(?:^|\/)(commands|skills)\/.+\.md$/i.test(commandPath);
          if (isCommand) {
            // AgentWorkflowService has one cache per workspace, no per-source invalidation API.
            getAgentWorkflowService(workspacePath).clearCache();
            changed();
          } else if (root === workspacePath && filePath === actionFile) changed();
        };
        try {
          await workspaceEventBus.subscribe(root, subscriberId, {
            onChange: handle, onAdd: handle, onUnlink: handle, receiveGitignoredStructureEvents: true,
          });
        } catch (error) {
          roots.delete(root);
          workspaceEventBus.unsubscribe(root, subscriberId);
          throw error;
        }
        if (!watch.active) { workspaceEventBus.unsubscribe(root, subscriberId); return; }
        // Includes action edits (gitignored) and any command discovered while setup ran.
        for (const [file, fileRoot] of watch.files) {
          if (fileRoot === root) workspaceEventBus.addGitignoreBypass(root, file, subscriberId);
        }
      }));
    }
    try { await refreshRoots(); }
    catch (error) { dispose(); throw error; }
    return dispose;
  },
};
