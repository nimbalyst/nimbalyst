/**
 * Renderer side of the page tree MCP tools (`collabIndexToolHandlers.ts` in
 * main). Each tool arrives on its channel with a one-shot `resultChannel`; the
 * listener runs the tool and replies once. The tools themselves live in
 * `@nimbalyst/collab-client/docs/pageTreeToolCore`, shared with the collab
 * worker's remote Pages tools.
 */
import { createDesktopPageTreeEnv } from './desktopPageTreeEnv';
import { trackDocumentAction } from '../../utils/collabIndexAnalytics';
import {
  createPageTool,
  deletePageTool,
  listPagesTool,
  movePageTreeNodeTool,
  renamePageTool,
  searchPagesTool,
  setPageFieldsTool,
  setPageTypeTool,
  type PageTreeToolEnv,
  type PageTreeToolResult,
} from '@nimbalyst/collab-client/docs/pageTreeToolCore';

type ToolPayload = Record<string, unknown> & { resultChannel?: string; workspacePath?: string };

export interface PageTreeToolIpc {
  on(channel: string, listener: (payload: ToolPayload) => void): () => void;
  send(channel: string, result: PageTreeToolResult): void;
}

/** The page analytics the old shared-index listeners sent for agent edits. */
const TRACKED: Record<string, 'moved' | 'renamed' | 'trashed'> = {
  'mcp:moveSharedItem': 'moved',
  'mcp:renameSharedItem': 'renamed',
  'mcp:deleteSharedItem': 'trashed',
};

function trackPageAction(channel: string, payload: ToolPayload): void {
  const action = TRACKED[channel];
  if (!action || payload.kind === 'item' || payload.kind === 'type') return;
  trackDocumentAction({ action, actorType: 'agent', documentType: null, entryPoint: 'agent_tool' });
}

const TOOLS: Record<string, (env: PageTreeToolEnv, args: Record<string, unknown>) => Promise<PageTreeToolResult>> = {
  'mcp:listPages': listPagesTool,
  'mcp:searchPages': searchPagesTool,
  'mcp:createSharedDoc': createPageTool,
  'mcp:createSharedFolder': createPageTool,
  'mcp:moveSharedItem': movePageTreeNodeTool,
  'mcp:renameSharedItem': renamePageTool,
  'mcp:deleteSharedItem': deletePageTool,
  'mcp:setPageType': setPageTypeTool,
  'mcp:setPageFields': setPageFieldsTool,
  // Loaded on first use: it brings in the share flow and its dialogs.
  'mcp:importFileToPages': (env, args) => import('./importFileToPagesTool').then(({ importFileToPagesTool }) => importFileToPagesTool(env, args)),
};

/** Subscribe every page tree tool channel; returns the unsubscribers. */
export function registerPageTreeToolHandlers(
  ipc: PageTreeToolIpc = {
    on: (channel, listener) => window.electronAPI.on(channel, listener),
    send: (channel, result) => window.electronAPI.send(channel, result),
  },
  envFor: (payload: ToolPayload) => PageTreeToolEnv = (payload) => createDesktopPageTreeEnv(payload.workspacePath),
): Array<() => void> {
  return Object.entries(TOOLS).map(([channel, tool]) => ipc.on(channel, (payload) => {
    const resultChannel = payload.resultChannel;
    if (!resultChannel) return;
    tool(envFor(payload), payload)
      .then((result) => {
        if (result.success) trackPageAction(channel, payload);
        ipc.send(resultChannel, result);
      })
      .catch((error: unknown) => ipc.send(resultChannel, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
  }));
}
