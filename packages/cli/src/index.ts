/**
 * nim — companion CLI for Nimbalyst trackers and agent interop.
 *
 * Entry point: parse argv, dispatch the noun, translate thrown CliErrors into
 * stable exit codes. All command output goes to stdout; diagnostics to stderr.
 */
import { parseArgs, flagBool } from './cli/parse.js';
import { setColorEnabled } from './cli/colors.js';
import { CliError, ExitCode } from './cli/exitCodes.js';
import { runTracker } from './commands/tracker.js';
import { runStatus } from './commands/status.js';
import { runWorkspace } from './commands/workspace.js';
import { runSession, runDoc } from './commands/sessionDoc.js';
import { runHostControlAdapter } from './commands/hostControlAdapter.js';

export const VERSION = '0.1.0';

const HELP = `nim — Nimbalyst companion CLI (v${VERSION})

Usage:
  nim <noun> <verb> [--flags]

Nouns:
  tracker     trackers (bugs, tasks, decisions, imported records) — read in v1
  session     AI sessions (read-only in v1)
  doc         workspace documents (read-only in v1)
  workspace   list / show workspaces
  status      what nim is connected to (live or direct), schema, workspaces
  host-control authenticated host-control adapter (one JSON object via stdin/stdout)

Tracker (read):
  nim tracker list   [--type T] [--status open|closed|<s>] [--priority P]
                     [--owner me|<o>] [--since 1d] [--until 2026-06-01]
                     [--where field=value] [--limit N | --all] [--json|--csv|-q]
  nim tracker get    <id|KEY|urn>
  nim tracker show   <id|KEY>            (pretty body render)
  nim tracker types  [show <type>]

Tracker (write — live mode; direct writes refused while the app owns the DB):
  nim tracker create <type> "<title>" [--status S] [--priority P] [--owner O]
                     [--tag T ...] [--field k=v ...] [--body TXT | --body-file F]
                     [--type-tag T ...] [--link-session]
  nim tracker update <id|KEY> [--status S] [--field k=v ...] [--unset f ...] …
  nim tracker comment <id|KEY> "<body>"   (or --body-file F)
  nim tracker archive <id|KEY> / nim tracker unarchive <id|KEY>
  nim tracker link-session <id|KEY> [--session <id>]   (live only)
  nim tracker types define -f <schema.yaml|.json> / nim tracker types rm <type>

Tracker (importers — live mode only):
  nim tracker importers                                  (list installed importers)
  nim tracker import search <providerId> [--repo owner/repo] [--state open|closed|all]
                     [--search TXT] [--limit N]
  nim tracker import <providerId> <externalId> [--type <trackerType>]
  nim tracker import resnapshot <urn>                    (e.g. github://owner/repo#42)

Cross-cutting flags:
  --workspace <path>   target workspace (default: resolve from cwd)
  --db <file>          direct mode against an explicit SQLite file
  --live / --offline   force access mode
  --json / --csv       machine output (JSON shape = TrackerRecord)
  --columns a,b,c      table/CSV columns
  --quiet, -q          ids only
  --no-color           disable ANSI color (also honors NO_COLOR)

Exit codes: 0 ok · 1 not found · 2 usage · 3 connection · 4 schema · 5 write-not-permitted · 6 rejected
`;

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return reportError(err);
  }

  if (flagBool(args, 'no-color')) setColorEnabled(false);

  if (flagBool(args, 'version')) {
    process.stdout.write(VERSION + '\n');
    return ExitCode.OK;
  }

  if (!args.noun || flagBool(args, 'help')) {
    process.stdout.write(HELP);
    return ExitCode.OK;
  }

  try {
    switch (args.noun) {
      case 'tracker':
        return await runTracker(args);
      case 'status':
        return await runStatus(args);
      case 'workspace':
        return await runWorkspace(args);
      case 'session':
        return await runSession(args);
      case 'doc':
        return await runDoc(args);
      case 'host-control':
        return await runHostControlAdapter(args);
      default:
        process.stderr.write(`nim: unknown command '${args.noun}'. Run 'nim --help'.\n`);
        return ExitCode.USAGE;
    }
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err: unknown): number {
  if (err instanceof CliError) {
    process.stderr.write(`nim: ${err.message}\n`);
    return err.code;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`nim: ${message}\n`);
  if (process.env.NIM_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  return ExitCode.CONNECTION;
}
