/**
 * `nim wiki serve [--port N] [--no-open] [--location <dir>] [--assets <dir>]`:
 * show the project's local wiki in a browser, opening it. Runs until interrupted.
 */
import { spawn } from 'node:child_process';
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagInt, flagStr, parseArgs } from '../cli/parse.js';
import { CliError, ExitCode, usageError } from '../cli/exitCodes.js';
import { openLocalWiki } from '../localWiki/open.js';
import { installHint, resolveWikiWebAssets } from './assets.js';
import { startWikiServer, type WikiServer } from './server.js';

export interface WikiServeContext {
  version: string;
  /** Stops the server (tests); otherwise SIGINT/SIGTERM do. */
  signal?: AbortSignal;
  /** Called once the server is listening. */
  onListening?: (server: WikiServer) => void;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // No opener on this host; the URL is printed anyway.
    });
    child.unref();
  } catch {
    // same: the printed URL is the fallback
  }
}

/**
 * Opens the browser by default for a person at a terminal. Not when output is
 * not a terminal (scripts, tests) or over SSH, where the browser would open on
 * the other machine; `--open` forces it and `--no-open` skips it.
 */
export function wantsOpen(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean {
  if (flagBool(args, 'no-open')) return false;
  if (flagBool(args, 'open')) return true;
  return isTTY && !env.SSH_CONNECTION && !env.SSH_TTY && !env.CI;
}

export async function runWikiServe(argv: ParsedArgs | string[], ctx: WikiServeContext): Promise<number> {
  const args = Array.isArray(argv) ? parseArgs(argv) : argv;
  const out = ctx.out ?? ((text: string) => process.stdout.write(text));
  const err = ctx.err ?? ((text: string) => process.stderr.write(text));
  const port = flagInt(args, 'port') ?? 0;
  if (port < 0 || port > 65535) throw usageError(`--port must be between 0 and 65535, got ${port}`);

  const opened = await openLocalWiki(flagStr(args, 'workspace') ?? process.cwd(), flagStr(args, 'location'));
  const resolution = resolveWikiWebAssets({ flag: flagStr(args, 'assets'), projectRoot: opened.projectRoot });
  if (!resolution.ok) {
    opened.wiki.close();
    err(installHint(ctx.version, resolution));
    return ExitCode.NOT_FOUND;
  }

  let server: WikiServer;
  try {
    server = await startWikiServer({
      wiki: opened.wiki,
      assetsDir: resolution.assets.dir,
      port,
      version: ctx.version,
      projectRoot: opened.projectRoot,
    });
  } catch (e) {
    opened.wiki.close();
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new CliError(ExitCode.CONNECTION, `Port ${port} is in use; pick another with --port or omit it`);
    throw e;
  }

  out(`Serving the local wiki at ${opened.dir}\n`);
  out(`Open: ${server.url}\n`);
  out('Only this machine can connect, and only with the token in that URL. Press Ctrl+C to stop.\n');
  if (wantsOpen(args)) openBrowser(server.url);
  ctx.onListening?.(server);

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    if (ctx.signal) {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener('abort', stop, { once: true });
    } else {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  });
  await server.close();
  opened.wiki.close();
  return ExitCode.OK;
}
