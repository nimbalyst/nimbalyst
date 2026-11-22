/**
 * Everything `nim mcp` serves. The list is the same whether or not a local wiki
 * exists; without one, each tool answers that `initLocalWiki` creates it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MARKER_FILE, type LocalWiki } from '@nimbalyst/local-wiki';
import { usageError } from '../cli/exitCodes.js';
import { projectRoot, resolveWikiLocation, settingPath, workspaceForFolder, type Workspace } from '../localWiki/locate.js';
import { initLocalWiki, openLocalWiki } from '../localWiki/open.js';
import { localPageUri } from '../localWiki/tree.js';
import { INIT_TOOL_NAME, refuseTeamScope, requireStr, str, USE_TOOL_NAME, type LocalWikiContext } from './localTools.js';
import { coverageTool } from './coverageTool.js';
import { doctorTool } from './doctorTool.js';
import { marksTool } from './marksTool.js';
import { pageTools } from './pageTools.js';
import { trackerTools } from './trackerTools.js';
import { textResult, ToolMap, TeamScopeRefusal, type McpTool } from './toolMap.js';

/**
 * Sent in `initialize`; hosts put it in the agent's system prompt. Static, so
 * initialize never waits on the disk: the server does not know yet whether a
 * wiki exists. Codex runs no plugin hooks, so this is also where it learns to
 * check covered pages after a change.
 */
export const LOCAL_SERVER_INSTRUCTIONS =
  "These tools read and write this project's local wiki, a folder of markdown pages, if it has one. " +
  'Before design work or a change in an area, call `searchPages` for it and read what matches; a page whose `paths` cover files you are about to change is worth reading first (`pagesForFiles` lists them). ' +
  'For "what did we decide" or "why did we", call `listMarks` first. ' +
  'After changing code, call `pagesForFiles` and update or flag the pages it returns; after deciding something, follow the `capture` skill from the nimbalyst-wiki plugin. ' +
  'Before writing or changing any wiki page, including architecture or product maps, diagrams, HTML pages and other visuals, load the `update` skill from the nimbalyst-wiki plugin and follow it. ' +
  'Every result names the wiki folder in use; if the session has moved to another project, call `useLocalWiki` with that project folder first. ' +
  'To open the wiki in a browser, call `openWikiInBrowser`; to see which version of these tools is running and how it was installed, call `wikiDoctor`. ' +
  "A `nim` command on the shell's PATH is a separate install that may be a different version from this server; do not use it for the wiki or to judge what this server runs.";

export function localWikiContext(startDir: string, location?: string): LocalWikiContext {
  // One LocalWiki per folder for the life of the server, re-scanned per call.
  const cache = new Map<string, LocalWiki>();
  // Fixed at launch until the agent's session moves to another project and calls useLocalWiki.
  let current: Workspace = { startDir, location };
  return {
    open: () => openLocalWiki(current.startDir, current.location, cache),
    // An agent's location is relative to the project root, not the server's cwd.
    init: (at) => initLocalWiki(current.startDir, at ? path.resolve(projectRoot(current.startDir), at) : current.location),
    workspace: () => current,
    use: (folder) => {
      const target = path.resolve(projectRoot(current.startDir), folder);
      if (!fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw usageError(`${target} is not a folder`);
      const next = workspaceForFolder(target, (dir) => fs.existsSync(path.join(dir, MARKER_FILE)));
      // Resolve before switching: an unreadable setting there leaves the server where it was.
      const where = resolveWikiLocation(next.startDir, next.location);
      current = next;
      return where;
    },
  };
}

function useTool(context: LocalWikiContext): McpTool {
  return {
    definition: {
      name: USE_TOOL_NAME,
      description:
        'Point this server at another project\'s local wiki, for the rest of the session. Call it when the session moved to a different project or the wiki tools name the wrong wiki folder. ' +
        '`folder` is the project folder (its wiki is found the same way as at startup: the main git checkout, then .nimbalyst/local-wiki.json, else nimbalyst-local/wiki) or the wiki folder itself. ' +
        `Returns the project root and wiki folder now in use; errors if no wiki exists there yet (\`${INIT_TOOL_NAME}\` creates it).`,
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Absolute path of the project folder or wiki folder. A relative path is relative to the current project root.' },
        },
        required: ['folder'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    call: async (args) => {
      try {
        refuseTeamScope(USE_TOOL_NAME, args);
        const where = context.use(requireStr(args, 'folder'));
        if (!fs.existsSync(path.join(where.dir, MARKER_FILE))) {
          return textResult(
            `Now using project ${where.projectRoot}, which has no local wiki at ${where.dir}. Call \`${INIT_TOOL_NAME}\` to create one there.`,
            true,
          );
        }
        return textResult({ projectRoot: where.projectRoot, wikiFolder: where.dir });
      } catch (err) {
        if (err instanceof TeamScopeRefusal) return textResult(err.message, true);
        return textResult(`${USE_TOOL_NAME}: ${(err as Error).message}`, true);
      }
    },
  };
}

function initTool(context: LocalWikiContext): McpTool {
  return {
    definition: {
      name: INIT_TOOL_NAME,
      description:
        "Create this project's local wiki: a folder of markdown pages with a Home page, which Nimbalyst, `nim` and agents all read and edit. " +
        'By default it goes in nimbalyst-local/wiki, which is kept out of git (private to this checkout). ' +
        'Pass `location` (relative to the project root, e.g. docs/wiki) for a wiki that is checked in and shared through git; ask the user which they want if it is not clear. ' +
        'Safe to call on an existing wiki: it changes nothing but the location setting.',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Wiki folder relative to the project root. Default: the configured location, else nimbalyst-local/wiki.' },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    call: async (args) => {
      try {
        refuseTeamScope(INIT_TOOL_NAME, args);
        const result = await context.init(str(args, 'location'));
        result.wiki.close();
        return textResult({
          dir: result.dir,
          created: result.created,
          home: result.homeId ? localPageUri(result.homeId) : null,
          settingFile: settingPath(result.projectRoot),
          gitignoreUpdated: result.gitignoreUpdated,
        });
      } catch (err) {
        if (err instanceof TeamScopeRefusal) return textResult(err.message, true);
        return textResult(`${INIT_TOOL_NAME}: ${(err as Error).message}`, true);
      }
    },
  };
}

export function createLocalToolMap(context: LocalWikiContext, extra: McpTool[] = [], options: { versions?: () => unknown } = {}): ToolMap {
  const tools = new ToolMap();
  for (const tool of [initTool(context), useTool(context), ...pageTools(context), ...trackerTools(context), coverageTool(context), doctorTool(context, options.versions), marksTool(context), ...extra]) tools.register(tool);
  return tools;
}
