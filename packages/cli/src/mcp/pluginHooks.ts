/**
 * What the nimbalyst-wiki plugin's hooks compute, with nothing that runs on
 * import. Two entries use it: wikiContextEntry.ts, bundled into the plugin as
 * scripts/wiki-context.mjs, and `nim hook` (commands/hook.ts), which the plugin
 * directory edition runs from the npm package instead of bundling.
 */
import { pagesForFiles } from '../localWiki/coverage.js';
import { readMigratedTo } from '../localWiki/locate.js';
import { buildWikiContext, HOOK_DEADLINE_MS, openWikiReadOnly } from './wikiContext.js';

/**
 * The local wiki pages covering `files` (absolute or repository-relative), or
 * the working tree's changes when `files` is empty. Empty without a wiki or
 * once it moved to a team project. Throws DeadlineExceeded past `deadline`;
 * the Stop hook treats that as none.
 */
export async function coveredPages(startDir: string, files: string[] = [], deadline = Date.now() + HOOK_DEADLINE_MS): Promise<Array<{ title: string; stale: boolean | null }>> {
  const opened = await openWikiReadOnly(startDir);
  if (!opened) return [];
  try {
    if (readMigratedTo(opened.projectRoot)) return [];
    const { pages } = await pagesForFiles(opened, { startDir, files, deadline });
    return pages.map(({ title, stale }) => ({ title, stale }));
  } finally {
    opened.wiki.close();
  }
}

function projectDir(input: unknown, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  if (fromEnv) return fromEnv;
  const cwd = input && typeof input === 'object' ? (input as { cwd?: unknown }).cwd : undefined;
  return typeof cwd === 'string' && cwd ? cwd : process.cwd();
}

/** The SessionStart hook's stdout line for the hook input, or null to print nothing. */
export async function sessionStartOutput(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const text = await buildWikiContext(projectDir(input, env), undefined, { deadline: Date.now() + HOOK_DEADLINE_MS });
  return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) : null;
}
