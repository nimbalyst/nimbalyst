/**
 * IPC handlers for action prompts (ai-actions.md).
 *
 * Channels:
 *   action-prompts:list                (request/response)  list actions for a workspace
 *   action-prompts:open-file           (request/response)  ensure file exists, then ask the renderer to open it in a tab
 *   action-prompts:launch-new-session  (request/response)  spawn a sibling session from a launcher action
 *   action-prompts:changed             (broadcast)         action list changed for a workspace
 *   action-prompts:launched            (broadcast)         a new session was launched from an action; renderer
 *                                                          should prefill drafts and/or focus as configured
 */

import { BrowserWindow } from 'electron';
import { getActionPromptService } from '../services/ActionPromptService';
import { findWindowByWorkspace } from '../window/WindowManager';
import { safeHandle } from '../utils/ipcRegistry';
import { MetaAgentService } from '../services/MetaAgentService';

const broadcastSubscribed = new Set<string>();

function broadcastChanged(workspacePath: string, payload: Awaited<ReturnType<ReturnType<typeof getActionPromptService>['list']>>) {
  const window = findWindowByWorkspace(workspacePath);
  if (window && !window.isDestroyed()) {
    window.webContents.send('action-prompts:changed', { workspacePath, ...payload });
  }
}

function ensureChangeBroadcast(workspacePath: string) {
  if (broadcastSubscribed.has(workspacePath)) return;
  broadcastSubscribed.add(workspacePath);
  const service = getActionPromptService(workspacePath);
  service.onChange(async () => {
    try {
      const result = await service.list();
      broadcastChanged(workspacePath, result);
    } catch (err) {
      console.error('[ActionPromptHandlers] Failed to broadcast changed list:', err);
    }
  });
}

export function registerActionPromptHandlers() {
  safeHandle('action-prompts:list', async (_event, payload: { workspacePath: string }) => {
    const workspacePath = payload?.workspacePath;
    if (!workspacePath) {
      throw new Error('action-prompts:list requires workspacePath');
    }
    const service = getActionPromptService(workspacePath);
    const result = await service.list();
    ensureChangeBroadcast(workspacePath);
    return result;
  });

  safeHandle('action-prompts:open-file', async (event, payload: { workspacePath: string }) => {
    const workspacePath = payload?.workspacePath;
    if (!workspacePath) {
      throw new Error('action-prompts:open-file requires workspacePath');
    }
    const service = getActionPromptService(workspacePath);
    const filePath = await service.ensureFileExists();

    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
      window.webContents.send('open-document', { path: filePath });
    }
    return { filePath };
  });

  safeHandle(
    'action-prompts:launch-new-session',
    async (
      event,
      payload: {
        workspacePath: string;
        parentSessionId: string;
        prompt: string;
        title?: string;
        actionLabel?: string;
        config: {
          model?: string;
          foreground: boolean;
          autoSubmit: boolean;
          worktree: boolean;
        };
      }
    ) => {
      const workspacePath = payload?.workspacePath;
      const parentSessionId = payload?.parentSessionId;
      const prompt = payload?.prompt;
      const config = payload?.config;

      if (!workspacePath) {
        throw new Error('action-prompts:launch-new-session requires workspacePath');
      }
      if (!parentSessionId) {
        throw new Error('action-prompts:launch-new-session requires parentSessionId');
      }
      if (!prompt || !prompt.trim()) {
        throw new Error('action-prompts:launch-new-session requires prompt');
      }
      if (!config || typeof config.foreground !== 'boolean' || typeof config.autoSubmit !== 'boolean') {
        throw new Error('action-prompts:launch-new-session requires a valid config');
      }

      const meta = MetaAgentService.getInstance();
      const launch = await meta.launchActionSession(parentSessionId, workspacePath, {
        prompt,
        title: payload.title || payload.actionLabel,
        model: config.model,
        autoSubmit: config.autoSubmit,
        useWorktree: !!config.worktree,
      });

      // Tell the renderer to wire up the new session: prefill its draft if
      // autoSubmit is false, focus it if foreground is true. Centralizing this
      // in a single broadcast keeps the renderer changes to one listener
      // entry instead of threading sessionId through component trees.
      //
      // We include both workstreamId (regular sibling case) and worktreeId
      // (worktree sibling case — workstreamId is null when the parent lives in
      // a worktree, since the worktree itself is the container). The renderer
      // needs both to drive `selectedWorkstreamAtom`, which is the actual
      // driver of the right-hand panel — without it, focus only updates the
      // global active-session atom and the panel can stay on the old session.
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && !window.isDestroyed()) {
        window.webContents.send('action-prompts:launched', {
          workspacePath,
          parentSessionId,
          sessionId: launch.sessionId,
          workstreamId: launch.workstreamId,
          worktreeId: launch.worktreeId,
          // The renderer prefills with the same prompt only when nothing was
          // queued. If autoSubmit was true the prompt is already on its way
          // through queuePromptForSession.
          draftInput: config.autoSubmit ? null : prompt,
          focus: config.foreground,
        });
      }

      return {
        sessionId: launch.sessionId,
        workstreamId: launch.workstreamId,
        worktreeId: launch.worktreeId,
        queuedInitialPrompt: launch.queuedInitialPrompt,
      };
    }
  );
}
