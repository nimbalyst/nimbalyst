/**
 * `nim hook <session-start|stop|session-inputs>`: the nimbalyst-wiki plugin's
 * hooks and its session-inputs server. The plugin starts these, and `nim mcp
 * --plugin-root`, through a pinned `npx @nimbalyst/cli@<version>`, so its
 * repository holds no generated code. The session-inputs server's source
 * lives in the knowledge extension (src/sessionInputs).
 *
 * A hook never blocks a session because it failed: any error prints nothing
 * and exits 0.
 */
import { readFileSync } from 'node:fs';
import { main as serveSessionInputs } from '@nimbalyst/wiki-plugin/session-inputs';
import { decide } from '../mcp/keeperNudge.js';
import { sessionStartOutput } from '../mcp/pluginHooks.js';
import { type ParsedArgs } from '../cli/parse.js';
import { ExitCode } from '../cli/exitCodes.js';

export const HOOK_VERBS = ['session-start', 'stop', 'session-inputs'] as const;

/** The hook's stdout line for `inputText` (the hook's stdin), or null to print nothing. */
export async function runHook(verb: 'session-start' | 'stop', inputText: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try {
    const input = JSON.parse(inputText || '{}');
    if (verb === 'session-start') return await sessionStartOutput(input, env);
    const result = await decide(input, env);
    return result ? JSON.stringify(result) : null;
  } catch {
    return null;
  }
}

export async function runHookCommand(args: ParsedArgs): Promise<number> {
  const verb = args.verb;
  if (verb === 'session-inputs') {
    serveSessionInputs();
    // The server answers until stdin closes; keep `main` from exiting first.
    await new Promise<void>((resolve) => process.stdin.on('close', resolve));
    return ExitCode.OK;
  }
  if (verb !== 'session-start' && verb !== 'stop') {
    process.stderr.write(`nim hook: expected one of ${HOOK_VERBS.join(', ')}\n`);
    return ExitCode.USAGE;
  }
  // stdout is the hook's answer; anything a dependency logs goes to stderr.
  console.log = console.error;
  let inputText = '';
  try {
    inputText = readFileSync(0, 'utf8');
  } catch {
    // no stdin: the hook answers from the environment alone
  }
  const line = await runHook(verb, inputText);
  if (line) process.stdout.write(`${line}\n`);
  return ExitCode.OK;
}
