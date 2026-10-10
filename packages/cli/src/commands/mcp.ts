/**
 * `nim mcp` — serve local wiki tools to an agent over stdio. See mcp/stdioServer.ts.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagStr } from '../cli/parse.js';
import { runStdioServer } from '../mcp/stdioServer.js';
import { createLocalToolMap, localWikiContext } from '../mcp/serverTools.js';

export async function runMcp(version: string, args: ParsedArgs): Promise<number> {
  // stdout is the protocol channel. Anything below that logs through console
  // would corrupt it, so route those calls to stderr for the life of the server.
  const toStderr = (...parts: unknown[]) => console.error(...parts);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;

  const context = localWikiContext(flagStr(args, 'workspace') ?? process.cwd(), flagStr(args, 'location'));
  process.stderr.write(`nim mcp ${version}: serving on stdio\n`);
  await runStdioServer({ tools: createLocalToolMap(context), serverInfo: { name: 'nimbalyst-local', version } });
  return 0;
}
