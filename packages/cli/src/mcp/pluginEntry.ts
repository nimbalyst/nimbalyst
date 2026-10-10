/**
 * The `nimbalyst-local` server as the Claude Code plugin runs it: `nim mcp`
 * alone, bundled into plugins/nimbalyst-wiki/scripts/nim-local-mcp.mjs by
 * scripts/build-wiki-plugin.mjs, since a plugin installed from git has no
 * `npm install`. Claude Code starts it in the project directory.
 */
import { runMcp } from '../commands/mcp.js';

declare const __NIM_VERSION__: string;

const workspace = process.env.CLAUDE_PROJECT_DIR || process.cwd();
runMcp(__NIM_VERSION__, { noun: 'mcp', positionals: [], flags: { workspace } }).catch((err) => {
  process.stderr.write(`nimbalyst-local: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
