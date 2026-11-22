/**
 * nim — companion CLI for Nimbalyst trackers and agent interop.
 *
 * Entry point: parse argv, dispatch the noun, translate thrown CliErrors into
 * stable exit codes. All command output goes to stdout; diagnostics to stderr.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs, flagBool, flagStr, type ParsedArgs } from './cli/parse.js';
import { terminalNotice, wantsTerminalNotice } from './cli/updateNotice.js';
import { detectNpmInstall, startUpdateCheck } from './mcp/updateCheck.js';
import { pluginServerSetup } from './mcp/pluginEntry.js';
import { machineEnv } from './update/installs.js';
import { runUpdate } from './commands/update.js';
import { runDoctor } from './commands/doctor.js';
import { runHookCommand } from './commands/hook.js';
import { setColorEnabled } from './cli/colors.js';
import { CliError, ExitCode } from './cli/exitCodes.js';
import { safeText } from './cli/output.js';
import { runTracker } from './commands/tracker.js';
import { runStatus } from './commands/status.js';
import { runWorkspace } from './commands/workspace.js';
import { runSession, runDoc } from './commands/sessionDoc.js';
import { runRelease } from './commands/release.js';
import { runLogin, runLogout, runWhoami } from './commands/login.js';
import { runPages } from './commands/pages.js';
import { runMcp } from './commands/mcp.js';
import { isLocalWikiCall, runLocalWiki } from './commands/wikiLocal.js';
import { runWikiServe } from './serve/runWikiServe.js';

/**
 * Set from package.json by the build (scripts/build.mjs) and the cli test
 * config, so it cannot drift. The repo-root test run has no such define.
 */
declare const __NIM_VERSION__: string;
export const VERSION: string = typeof __NIM_VERSION__ === 'string' ? __NIM_VERSION__ : '0.0.0-dev';
/** The running bundle (dist/bin/cli.js once built), which tells us how this nim was installed. */
const ENTRY_FILE = fileURLToPath(import.meta.url);

const PAGES_HELP = `Wiki: one noun for the local wiki (files in this project, no account) and the team wiki.
  list (ls), read, move and search use the local wiki when the project has one, else the team wiki;
  a collab:// uri, a console link or --repo/--org/--project means team. --team / --local force it.

Team wiki (Nimbalyst Teams sign-in; server = NIM_SERVER, default https://sync.nimbalyst.com):
  nim login / nim logout / nim whoami
  nim wiki status                           (unbound, bound, or ambiguous, with your teams)
  nim wiki bind --org <id> --project <id>   (team admins: connect this repo's remote)
  nim wiki create-project --org <id> --name <n> [--bind]   (team admins)
  nim wiki team-create "<name>"              (a new team you administer; its first project is bound to this repo)
  nim wiki invite --org <id> <email>... [--role member|admin] [--project <id> --project-role editor|commenter|viewer]   (team admins)
  nim wiki invite-link --org <id> [--project <id>] [--role R] [--project-role R] [--expires-in SECONDS] [--max-uses N]
  nim wiki pin --org <id> --project <id>    (writes .nimbalyst/wiki.json; one of the projects this repo resolves to)
  nim wiki list                             (the page tree, with links)
  nim wiki read <uri|link>
  nim wiki search <query> [--limit n]       (page titles and text)
  nim wiki edit <uri|link> --old TXT --new TXT [...]   (or --replacements-file F)
  nim wiki create "<title>" [--parent ID] [--parent-kind page|item] [--path A/B]
                     [--body TXT | --body-file F] [--before NODE | --after NODE]
  nim wiki create-folder "<name>" [--parent ID] [--path A/B]
  nim wiki move <id> --kind page|item|type [--parent ID] [--path A/B]
                     [--before NODE | --after NODE] [--under-type]
  nim wiki rename <pageId> "<name>"
  nim wiki delete <pageId> --kind doc|folder
  nim wiki set-type <pageId> <typeId>
  nim wiki set-fields <pageId> [--owner <email>] [--status draft|current|outdated] [--summary <text>] [--tag <t>]... [--clear <field>]...
  nim wiki members [query]
  nim wiki types [--search S]
  nim wiki define-type [-f <schema.yaml|.json>] [--predicates-file F] [--overwrite]
                     [--remove-predicate ID ...] [--confirm-destructive]
  nim wiki items [--type T] [--status S] [--search TXT] [--where f=v ...] [--include-closed] [--limit N]
  nim wiki item <id|KEY>
  nim wiki create-item <type> "<title>" [--status S] [--field k=v ...] [--tag T ...] [--body TXT | --body-file F]
  nim wiki update-item <id|KEY> [--title T] [--status S] [--field k=v ...] [--unset f ...]
                     [--body TXT | --body-file F] [--archive | --unarchive] [--expected-revision N]
  nim wiki comments --page <uri> [...] [--query TXT]   (citable comments)
  Target flags: --repo <remote> (default: origin; ignores .nimbalyst/wiki.json),
                --org <id> --project <id> (explicit project; ignores .nimbalyst/wiki.json)
`;

const help = () => `nim — Nimbalyst companion CLI (v${VERSION})

Usage:
  nim <noun> <verb> [--flags]

Nouns:
  tracker     trackers (bugs, tasks, decisions, imported records) — read in v1
  release     release items — list, finalize at build time, generate notes
  session     AI sessions (read-only in v1)
  doc         workspace documents (read-only in v1)
  workspace   list / show workspaces
  status      what nim is connected to (live or direct), schema, workspaces
  mcp         MCP server on stdio for agents: local wiki pages and typed pages (stdout is protocol only)
  hook        the Nimbalyst Wiki plugin hooks: session-start, stop, session-inputs (stdin is the hook input)
  update      update nim and the Nimbalyst Wiki plugins for Claude Code and Codex
  doctor      which nim and browser app this is, how they were installed, and the installed plugins

Update and versions:
  nim update [--check] [--dry-run] [--only cli|claude|codex]
                     (--check: report only, exit 1 if anything is out of date)
  nim doctor [--versions] [--json]
  A terminal command prints one line on stderr when a newer nim is published (once a day at most;
  NIMBALYST_WIKI_NO_UPDATE_CHECK=1 turns it off).

Tracker (read):
  nim tracker ready  [--type T] [--limit N | --all] [--json|--csv|-q]
  nim tracker list   [--type T] [--status open|closed|<s>] [--priority P]
                     [--owner me|<o>] [--since 1d] [--until 2026-06-01]
                     [--where field=value] [--limit N | --all] [--json|--csv|-q]
                     [--inbox]                (still needs a triage decision; live mode)
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

Release (live mode for writes):
  nim release list [--pending] [--json]
  nim release finalize [<id|KEY>] --version X.Y.Z [--tag vX.Y.Z] [--channel alpha|stable]
                     [--date <iso>]        (fills the existing item, flips it to released)
  nim release notes [<id|KEY>] [--json]    (markdown from the release's members)

${PAGES_HELP}
Local wiki (a folder of markdown pages in this project):
  nim wiki init [--location <path>]          (default nimbalyst-local/wiki; saved in .nimbalyst/local-wiki.json)
  nim wiki list [--json]                     (the page tree; also ls)
  nim wiki read <id|path|title> [--json]     (--json includes the version for write)
  nim wiki write <id|path|title> [--file F] [--expected-version V] [--create [--parent P]]
                                             (body from --file or stdin; exit 7 if the page changed since V)
  nim wiki move <page> [--parent P | --root | --before P | --after P] [--title T]
  nim wiki search <words> [--limit N] [--json]
  nim wiki convert-type <type> --to pages    (a table type becomes one page per row; ids and fields kept)
  nim wiki serve [--port N] [--no-open]      (opens the wiki in your browser to read and edit; loopback only)
  nim wiki move-to-team [--org <id> --project <id>] [--dry-run]
                                             (the whole wiki into this repo's team project; needs nim login;
                                              local files are kept, re-running resumes)
  nim wiki publish [--dry-run] [--confirm-removals] [--json]
                                             (copy the wiki one way into its team project for reviewers; the files
                                              stay the source, team edits are refused and reported, pages deleted
                                              here go to team Trash unless edited there)
  nim wiki publish --init [--org <id>] [--project <id>] [--name N]
                                             (choose or create the team project, record it, publish)
  nim wiki comments [<page>] [--json]        (open comment threads on the published pages, by local file)
  nim wiki publish-diff <page>               (a page edited in the team, as a diff against its file)
  nim wiki export --static <dir> [--title T] [--base /docs/] [--subtree <page>] [--exclude-type a,b]
                 [--outside-refs text|console] [--keep-identity] [--tracker-items linked|none]
                                             (the wiki as a static website, read-only; pages with
                                              export: false and person fields are left out)
  nim tracker list/get/show/create/update   use the local wiki for wiki types (storage: pages|table
                                             in the type's YAML) and items already there; --local forces it
  --location overrides the folder.

Cross-cutting flags:
  --workspace <path>   target workspace (default: resolve from cwd)
  --db <file>          direct mode against an explicit SQLite file
  --live / --offline   force access mode
  --json / --csv       machine output (JSON shape = TrackerRecord)
  --columns a,b,c      table/CSV columns
  --quiet, -q          ids only
  --no-color           disable ANSI color (also honors NO_COLOR)

Exit codes: 0 ok · 1 not found · 2 usage · 3 connection · 4 schema · 5 write-not-permitted · 7 conflict
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
    process.stdout.write(help());
    return ExitCode.OK;
  }

  const code = await dispatch(args);
  if (wantsTerminalNotice(args, Boolean(process.stderr.isTTY))) {
    const notice = terminalNotice({ entryFile: ENTRY_FILE, version: VERSION });
    if (notice) process.stderr.write(notice);
  }
  return code;
}

async function dispatch(args: ParsedArgs): Promise<number> {
  try {
    switch (args.noun) {
      case 'tracker':
        return await runTracker(args);
      case 'release':
        return await runRelease(args);
      case 'status':
        return await runStatus(args);
      case 'workspace':
        return await runWorkspace(args);
      case 'session':
        return await runSession(args);
      case 'doc':
        return await runDoc(args);
      case 'login':
        return await runLogin(args);
      case 'logout':
        return await runLogout(args);
      case 'whoami':
        return await runWhoami(args);
      case 'wiki':
        if (args.verb === 'serve') return await runWikiServe(args, { version: VERSION });
        return isLocalWikiCall(args) ? await runLocalWiki(args, VERSION) : await runPages(args);
      case 'mcp': {
        const pluginFlags = { root: flagStr(args, 'plugin-root'), agent: flagStr(args, 'plugin-agent') };
        if (pluginFlags.root || pluginFlags.agent) {
          // The nimbalyst-wiki plugin's server; see mcp/pluginEntry.ts.
          const setup = pluginServerSetup(machineEnv(), process.cwd(), pluginFlags, VERSION);
          const check = setup.install.kind === 'plugin' ? startUpdateCheck({ install: setup.install }) : null;
          const pluginArgs = { ...args, flags: { ...args.flags, workspace: setup.workspace } };
          return await runMcp(VERSION, pluginArgs, { takeNotice: check?.takeNotice, install: setup.install, executable: ENTRY_FILE });
        }
        const install = detectNpmInstall(ENTRY_FILE, VERSION);
        const check = install.kind === 'npm' ? startUpdateCheck({ install }) : null;
        return await runMcp(VERSION, args, { takeNotice: check?.takeNotice, install, executable: ENTRY_FILE });
      }
      case 'update':
        return await runUpdate(args, { version: VERSION, entryFile: ENTRY_FILE });
      case 'doctor':
        return await runDoctor(args, { version: VERSION, entryFile: ENTRY_FILE });
      case 'hook':
        return await runHookCommand(args);
      default:
        process.stderr.write(`nim: unknown command '${args.noun}'. Run 'nim --help'.\n`);
        return ExitCode.USAGE;
    }
  } catch (err) {
    return reportError(err);
  }
}

function reportError(err: unknown): number {
  // Messages can carry server- or team-written text; strip terminal control sequences.
  if (err instanceof CliError) {
    process.stderr.write(`nim: ${safeText(err.message)}\n`);
    return err.code;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`nim: ${safeText(message)}\n`);
  if (process.env.NIM_DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  return ExitCode.CONNECTION;
}
