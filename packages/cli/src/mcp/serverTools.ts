/**
 * Everything `nim mcp` serves. The list is the same whether or not a local wiki
 * exists; without one, each tool answers that `initLocalWiki` creates it.
 */
import * as path from 'node:path';
import type { LocalWiki } from '@nimbalyst/local-wiki';
import { projectRoot, settingPath } from '../localWiki/locate.js';
import { initLocalWiki, openLocalWiki } from '../localWiki/open.js';
import { localPageUri } from '../localWiki/tree.js';
import { INIT_TOOL_NAME, refuseTeamScope, str, type LocalWikiContext } from './localTools.js';
import { pageTools } from './pageTools.js';
import { trackerTools } from './trackerTools.js';
import { textResult, ToolMap, TeamScopeRefusal, type McpTool } from './toolMap.js';

export function localWikiContext(startDir: string, location?: string): LocalWikiContext {
  // One LocalWiki per folder for the life of the server, re-scanned per call.
  const cache = new Map<string, LocalWiki>();
  return {
    open: () => openLocalWiki(startDir, location, cache),
    // An agent's location is relative to the project root, not the server's cwd.
    init: (at) => initLocalWiki(startDir, at ? path.resolve(projectRoot(startDir), at) : location),
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

export function createLocalToolMap(context: LocalWikiContext): ToolMap {
  const tools = new ToolMap();
  for (const tool of [initTool(context), ...pageTools(context), ...trackerTools(context)]) tools.register(tool);
  return tools;
}
