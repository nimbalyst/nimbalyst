import {getAgentWorkflowService} from '../../AgentWorkflowService';
import { getWorkspaceState, updateWorkspaceState } from '../../../utils/store';
import { safeHandle } from '../../../utils/ipcRegistry';
import { remoteSessions } from '../remoteSessions';

export function registerRemoteSessionHandlers(): void {
  safeHandle('ai:remoteWorkspaceContext', async (_event, id: string, workspace: string) => {
    const context = await remoteSessions.workspaceContext(id, workspace) as {files: string[]; commands: Array<{name: string}>};
    const explicit = (await getAgentWorkflowService(workspace).listEntries({provider: 'claude-code'})).filter(entry => entry.content);
    return {...context, commands: [...explicit, ...context.commands.filter(command => !explicit.some(entry => entry.name === command.name))]};
  });
  safeHandle('ai:remoteHosts', (_event, workspace: string) => remoteSessions.hosts(workspace));
  safeHandle('ai:createRemoteSession', (_event, workspace: string, host: string, options) => remoteSessions.create(workspace, host, options));
  safeHandle('ai:loadRemoteDraft', async (_event, id: string, workspace: string) => {
    if (!await remoteSessions.get(id, workspace)) throw new Error('Remote session unavailable.');
    return getWorkspaceState(workspace).remoteSessionDrafts?.[id] ?? {text: '', attachments: []};
  });
  safeHandle('ai:saveRemoteDraft', async (_event, id: string, workspace: string, draft) => {
    if (!await remoteSessions.get(id, workspace)) throw new Error('Remote session unavailable.');
    if (typeof draft?.text !== 'string' || draft.text.length > 100000 || !Array.isArray(draft.attachments) || draft.attachments.length > 8) throw new Error('Invalid remote draft.');
    updateWorkspaceState(workspace, state => { state.remoteSessionDrafts = {...state.remoteSessionDrafts, [id]: draft}; });
  });
  const watches = new Map<string, () => void>();
  safeHandle('ai:watchRemoteSession', async (event, sessionId: string, workspacePath: string, watchId: string) => {
    if (typeof watchId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(watchId)) throw new Error('Invalid remote transcript subscription.');
    const key = `${event.sender.id}:${watchId}`;
    watches.get(key)?.();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const cleanup = () => {
      disposed = true; unsubscribe?.();
      if (watches.get(key) === cleanup) watches.delete(key);
      event.sender.removeListener('destroyed', cleanup);
    };
    watches.set(key, cleanup);
    event.sender.once('destroyed', cleanup);
    try {
      unsubscribe = await remoteSessions.watch(sessionId, workspacePath, snapshot => {
        if (!disposed && !event.sender.isDestroyed()) event.sender.send('ai:remoteSessionSnapshot', { watchId, snapshot });
      });
      if (disposed) unsubscribe();
      return { success: true };
    } catch (error) { cleanup(); throw error; }
  });
  safeHandle('ai:unwatchRemoteSession', (event, watchId: string) => {
    watches.get(`${event.sender.id}:${watchId}`)?.();
  });
  safeHandle('ai:queueRemotePrompt', (_event, sessionId: string, workspacePath: string, prompt: string, attachments: import("@nimbalyst/runtime/ai/server/types").ChatAttachment[] = [], options?: import("@nimbalyst/runtime/sync/types").RemoteTurnOptions) => remoteSessions.queue(sessionId, workspacePath, prompt, attachments, options));
  safeHandle('ai:cancelRemoteSession', (_event, sessionId: string, workspacePath: string) => remoteSessions.cancel(sessionId, workspacePath));
}
