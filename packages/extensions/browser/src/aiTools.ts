/**
 * Agentic control tools for the Browser extension.
 *
 * These expose the main-process BrowserSessionService interaction surface to
 * AI agents. Two targeting modes (see EXTENSION_ARCHITECTURE / the browser
 * plan):
 *
 *  - Editor-scoped tools (navigate/reload/click/type/evaluate/get_page_info/
 *    screenshot/scroll/back/forward) act on the *.browser.json or *.html editor
 *    the user currently has open. The editor registers its session id via
 *    host.registerEditorAPI(), which the host hands to the tool as
 *    `context.editorAPI`. An explicit `sessionId` param always overrides.
 *
 *  - Global tools (open_session / open_local_preview / list_sessions /
 *    close_session) manage sessions directly and default to creating
 *    agent-owned *headless* sessions (rendered in a shared off-screen window)
 *    so an agent can drive a browser without the user opening a tab.
 *
 * Tool handlers run in the renderer, so they call the browserClient IPC
 * wrappers directly.
 */

import type { ExtensionAITool, AIToolContext } from '@nimbalyst/extension-sdk';
import {
  clickInBrowserSession,
  createBrowserSession,
  destroyBrowserSession,
  evaluateInBrowserSession,
  getBrowserPageInfo,
  listBrowserSessions,
  navigateBrowserSession,
  reloadBrowserSession,
  goBackBrowserSession,
  goForwardBrowserSession,
  buildPreviewUrl,
  screenshotBrowserSessionToFile,
  scrollBrowserSession,
  typeInBrowserSession,
} from './browserClient';

/** Imperative API an editor registers so editor-scoped tools can find its session. */
export interface BrowserEditorAPI {
  getSessionId: () => string;
}

/** File patterns the editor-scoped tools apply to. */
const EDITOR_PATTERNS = ['*.browser.json', '*.html', '*.htm'];

/**
 * Resolve which session a tool should act on: an explicit `sessionId` param
 * wins; otherwise fall back to the active editor's registered session.
 */
function resolveSessionId(params: Record<string, unknown>, context: AIToolContext): string {
  const explicit = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  if (explicit) return explicit;
  const api = context.editorAPI as BrowserEditorAPI | undefined;
  const fromEditor = api?.getSessionId?.();
  if (fromEditor) return fromEditor;
  throw new Error(
    'No target browser session. Open a .browser.json/.html editor, or pass an explicit sessionId (e.g. from browser.open_session).',
  );
}

function targetFromParams(params: Record<string, unknown>): {
  selector?: string;
  index?: number;
} {
  const out: { selector?: string; index?: number } = {};
  if (typeof params.selector === 'string') out.selector = params.selector;
  if (typeof params.index === 'number') out.index = params.index;
  return out;
}

const SESSION_ID_PROP = {
  sessionId: {
    type: 'string' as const,
    description:
      'Optional explicit browser session id (e.g. from browser.open_session). Omit to target the browser editor the user currently has open.',
  },
};

const TARGET_PROPS = {
  selector: { type: 'string' as const, description: 'CSS selector of the target element.' },
  index: {
    type: 'number' as const,
    description: 'Index of an element from a prior browser.get_page_info `interactive` list.',
  },
};

export const aiTools: ExtensionAITool[] = [
  // ---------- Global session management ----------
  {
    name: 'browser.open_session',
    scope: 'global',
    description:
      'Open a new browser session and load a URL. By default the session is headless (agent-owned, rendered off-screen) so you can drive it without a visible tab. Returns the sessionId to use with the other browser tools.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s):// or nim-preview:// URL to load.' },
        headless: {
          type: 'boolean',
          description: 'Default true. Set false to require an attached editor tab instead.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional stable id to reuse; auto-generated if omitted.',
        },
        width: { type: 'number', description: 'Viewport width in CSS px (headless only).' },
        height: { type: 'number', description: 'Viewport height in CSS px (headless only).' },
      },
      required: ['url'],
    },
    handler: async (params) => {
      const url = String(params.url ?? '');
      if (!url) return { success: false, error: 'url is required' };
      const headless = params.headless !== false;
      const sessionId =
        (typeof params.sessionId === 'string' && params.sessionId) ||
        `agent-browser:${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const viewport =
        typeof params.width === 'number' && typeof params.height === 'number'
          ? { width: params.width, height: params.height }
          : undefined;
      try {
        const state = await createBrowserSession(sessionId, url, { headless, viewport });
        return {
          success: true,
          message: `Opened browser session ${sessionId}`,
          data: { sessionId, state },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.open_local_preview',
    scope: 'global',
    description:
      'Open a workspace-relative or absolute local HTML file as a live preview in a browser session (served over nim-preview:// so relative assets resolve). Headless by default. Returns the sessionId.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to an .html/.htm file in the workspace.' },
        headless: { type: 'boolean', description: 'Default true.' },
      },
      required: ['filePath'],
    },
    handler: async (params, context) => {
      const filePath = String(params.filePath ?? '');
      if (!filePath) return { success: false, error: 'filePath is required' };
      const headless = params.headless !== false;
      try {
        const url = await buildPreviewUrl(filePath, context.workspacePath);
        const sessionId = `agent-preview:${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const state = await createBrowserSession(sessionId, url, { headless });
        return { success: true, message: `Preview opened for ${filePath}`, data: { sessionId, url, state } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.list_sessions',
    scope: 'global',
    description: 'List the ids of all open browser sessions (both editor-backed and agent-owned).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      try {
        const sessionIds = await listBrowserSessions();
        return { success: true, data: { sessionIds } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.close_session',
    scope: 'global',
    description: 'Close an agent-owned browser session and free its resources.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'Session id to close.' } },
      required: ['sessionId'],
    },
    handler: async (params) => {
      const sessionId = String(params.sessionId ?? '');
      if (!sessionId) return { success: false, error: 'sessionId is required' };
      try {
        await destroyBrowserSession(sessionId);
        return { success: true, message: `Closed ${sessionId}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },

  // ---------- Editor-scoped interaction ----------
  {
    name: 'browser.navigate',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description: 'Navigate the target browser session to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s):// or nim-preview:// URL.' },
        ...SESSION_ID_PROP,
      },
      required: ['url'],
    },
    handler: async (params, context) => {
      try {
        const sid = resolveSessionId(params, context);
        await navigateBrowserSession(sid, String(params.url ?? ''));
        return { success: true, message: `Navigating to ${params.url}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.reload',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description: 'Reload the current page in the target browser session.',
    inputSchema: { type: 'object', properties: { ...SESSION_ID_PROP } },
    handler: async (params, context) => {
      try {
        await reloadBrowserSession(resolveSessionId(params, context));
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.go_back',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description: 'Go back one entry in the session navigation history.',
    inputSchema: { type: 'object', properties: { ...SESSION_ID_PROP } },
    handler: async (params, context) => {
      try {
        await goBackBrowserSession(resolveSessionId(params, context));
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.go_forward',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description: 'Go forward one entry in the session navigation history.',
    inputSchema: { type: 'object', properties: { ...SESSION_ID_PROP } },
    handler: async (params, context) => {
      try {
        await goForwardBrowserSession(resolveSessionId(params, context));
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.get_page_info',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description:
      'Read the current page: url, title, visible text (truncated), and an indexed list of interactive elements (links, buttons, inputs). Use the returned `index` values with browser.click / browser.type.',
    inputSchema: { type: 'object', properties: { ...SESSION_ID_PROP } },
    handler: async (params, context) => {
      try {
        const info = await getBrowserPageInfo(resolveSessionId(params, context));
        return { success: true, data: info };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.click',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description:
      'Click an element via a real input event. Target by CSS selector, by an index from browser.get_page_info, or by explicit x/y CSS-pixel coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        x: { type: 'number', description: 'X coordinate in CSS px (alternative to selector/index).' },
        y: { type: 'number', description: 'Y coordinate in CSS px (alternative to selector/index).' },
        ...SESSION_ID_PROP,
      },
    },
    handler: async (params, context) => {
      try {
        const sid = resolveSessionId(params, context);
        const target = targetFromParams(params);
        const x = typeof params.x === 'number' ? params.x : undefined;
        const y = typeof params.y === 'number' ? params.y : undefined;
        await clickInBrowserSession(sid, { ...target, x, y });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.type',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description:
      'Type text into an element (real character events, safe for controlled inputs). Target by selector or index; omit both to type into the focused element. Set clear=true to empty the field first.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        clear: { type: 'boolean', description: 'Clear the field before typing.' },
        ...TARGET_PROPS,
        ...SESSION_ID_PROP,
      },
      required: ['text'],
    },
    handler: async (params, context) => {
      try {
        const sid = resolveSessionId(params, context);
        await typeInBrowserSession(sid, {
          ...targetFromParams(params),
          text: String(params.text ?? ''),
          clear: params.clear === true,
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.scroll',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description:
      'Scroll the page by a delta (dx/dy) or scroll a selector/index element into view.',
    inputSchema: {
      type: 'object',
      properties: {
        dx: { type: 'number', description: 'Horizontal scroll delta in px.' },
        dy: { type: 'number', description: 'Vertical scroll delta in px.' },
        ...TARGET_PROPS,
        ...SESSION_ID_PROP,
      },
    },
    handler: async (params, context) => {
      try {
        const sid = resolveSessionId(params, context);
        await scrollBrowserSession(sid, {
          ...targetFromParams(params),
          dx: typeof params.dx === 'number' ? params.dx : undefined,
          dy: typeof params.dy === 'number' ? params.dy : undefined,
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.evaluate',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description:
      'Run JavaScript in the page and return its (serializable) result. The expression is awaited, so you can return a Promise. Use for reading DOM state or driving interactions selectors can’t express.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
        ...SESSION_ID_PROP,
      },
      required: ['script'],
    },
    handler: async (params, context) => {
      try {
        const sid = resolveSessionId(params, context);
        const result = await evaluateInBrowserSession(sid, String(params.script ?? ''));
        return { success: true, data: { result } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    name: 'browser.screenshot',
    scope: 'editor',
    editorFilePatterns: EDITOR_PATTERNS,
    description:
      'Capture a screenshot of the target browser session and save it as a PNG under the workspace. Returns the file path so you can view it.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Optional label used in the filename.' },
        ...SESSION_ID_PROP,
      },
    },
    handler: async (params, context) => {
      if (!context.workspacePath) {
        return { success: false, error: 'No workspace open; cannot save screenshot.' };
      }
      try {
        const sid = resolveSessionId(params, context);
        const path = await screenshotBrowserSessionToFile(
          sid,
          context.workspacePath,
          typeof params.label === 'string' ? params.label : undefined,
        );
        return { success: true, message: `Screenshot saved to ${path}`, data: { path } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  },
];
