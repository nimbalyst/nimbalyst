/**
 * A repository reaches its team's pages through the team project an admin
 * bound its remote to. `status`, `pin`, `bind`, and `create-project` live
 * here, with the target resolution every other `nim wiki` call uses.
 *
 * Membership is decided in Nimbalyst Teams, never here: the pin in
 * `.nimbalyst/wiki.json` only chooses among projects the caller can already
 * reach, and the server re-checks it on every call.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagStr } from '../cli/parse.js';
import { usageError } from '../cli/exitCodes.js';
import { safeText } from '../cli/output.js';
import { dim } from '../cli/colors.js';
import { outputOptions } from './common.js';
import {
  locateCheckout,
  resolveTeamsTarget,
  writeProjectPin,
  type ProjectPin,
  type TeamsTarget,
} from '../cloud/repo.js';
import { renderObject, renderRows, type Column } from '../cloud/pagesOutput.js';
import { print, tool, type PagesCtx } from './pagesCtx.js';

interface TeamRef {
  orgId: string;
  orgName?: string;
  orgSlug?: string;
  role?: string;
  /** `unbound` only (rev 10.4): the team's projects this user can reach, to bind to. */
  projects?: Array<{ projectId: string; projectName?: string }>;
}

interface ProjectRef extends TeamRef {
  projectId: string;
  projectName?: string;
  url?: string;
}

const isAdmin = (role: unknown) => role === 'admin' || role === 'owner';
const pinText = (p: ProjectPin) => `${p.orgId}/${p.projectId}`;
const named = (name: unknown, id: unknown) => (name ? `${name} (${id})` : String(id ?? ''));

const TEAM_COLUMNS: Column[] = [
  { header: 'team', get: (t) => t.orgName },
  { header: 'org', get: (t) => t.orgId },
  { header: 'role', get: (t) => t.role },
];

const PROJECT_COLUMNS: Column[] = [
  { header: 'team', get: (p) => p.orgName },
  { header: 'org', get: (p) => p.orgId },
  { header: 'project', get: (p) => p.projectName },
  { header: 'id', get: (p) => p.projectId },
  { header: 'role', get: (p) => p.role },
];

/** `--org` and `--project` name a project together; one without the other is a mistake. */
function flagPin(args: ParsedArgs): ProjectPin | undefined {
  const orgId = flagStr(args, 'org');
  const projectId = flagStr(args, 'project');
  if (!orgId && !projectId) return undefined;
  if (!orgId || !projectId) throw usageError('--org and --project must be given together.');
  return { orgId, projectId };
}

function sameProject(a: ProjectPin, b: ProjectPin): boolean {
  return a.orgId === b.orgId && a.projectId === b.projectId;
}

export function teamsCtx(args: ParsedArgs, server: string, startDir: string): PagesCtx {
  // bind / create-project / pin use --org and --project as their own operands, not as a target.
  const ownsProjectFlags = args.verb === 'bind' || args.verb === 'create-project' || args.verb === 'pin';
  if (ownsProjectFlags) {
    const { root, origin } = locateCheckout(startDir);
    const explicitRepo = flagStr(args, 'repo');
    // A pin lives in this checkout's wiki.json, so it can only be for this checkout's remote.
    if (args.verb === 'pin' && explicitRepo && explicitRepo !== origin) {
      throw usageError(
        `'nim wiki pin' writes ${root}/.nimbalyst/wiki.json, which is for ${origin ?? 'a checkout with no origin remote'}, not --repo ${explicitRepo}. Run it from that repository's checkout.`,
      );
    }
    return { args, server, root, base: { repo: explicitRepo ?? origin } };
  }
  const target: TeamsTarget = resolveTeamsTarget(startDir, { repo: flagStr(args, 'repo'), project: flagPin(args) });
  return { args, server, root: target.root, base: { repo: target.repo, project: target.project } };
}

function renderStatus(ctx: PagesCtx, res: any): string {
  const opts = outputOptions(ctx.args);
  const repo = ctx.base.repo as string | undefined;
  const pin = ctx.base.project as ProjectPin | undefined;
  if (opts.quiet) return safeText(String(res?.state ?? ''));
  if (opts.csv) {
    if (res?.state === 'bound') return renderRows([res.project], PROJECT_COLUMNS, opts, (p) => p.projectId);
    if (res?.state === 'ambiguous') return renderRows(res.projects ?? [], PROJECT_COLUMNS, opts, (p) => p.projectId);
    return renderRows(res?.teams ?? [], TEAM_COLUMNS, opts, (t) => t.orgId);
  }

  if (res?.state === 'bound') {
    const p: ProjectRef = res.project ?? {};
    return renderObject(
      {
        repo,
        state: 'bound',
        team: named(p.orgName, p.orgId),
        project: named(p.projectName, p.projectId),
        role: p.role,
        url: p.url,
        home: res.homeLink,
        guide: res.guideLink,
        user: res.user?.email,
        pinned: pin ? pinText(pin) : undefined,
      },
      opts,
    );
  }

  if (res?.state === 'ambiguous') {
    return [
      `${repo ? safeText(repo) : 'This checkout'} is connected to more than one team project you can reach:`,
      renderRows(res.projects ?? [], PROJECT_COLUMNS, opts, (p) => p.projectId),
      '',
      'Pick one and pin it (writes .nimbalyst/wiki.json; commit it so teammates resolve the same project):',
      '  nim wiki pin --org <orgId> --project <projectId>',
    ].join('\n');
  }

  if (res?.state !== 'unbound') return renderObject({ repo, state: res?.state }, opts);
  const teams: TeamRef[] = Array.isArray(res.teams) ? res.teams : [];
  const lines = [`${repo ? safeText(repo) : 'This checkout'} is not connected to a Nimbalyst team project.`];
  if (teams.length === 0) {
    lines.push(
      'You are not in any Nimbalyst team yet. Create a team and a project in the Nimbalyst console, or ask a team admin to invite you.',
    );
    return lines.join('\n');
  }
  lines.push('', 'Your teams:', renderRows(teams, TEAM_COLUMNS, opts, (t) => t.orgId), '');
  const adminOf = teams.filter((t) => isAdmin(t.role));
  if (adminOf.length === 0 || !repo) {
    lines.push(repo ? 'Ask a team admin to connect this repo in Nimbalyst.' : 'This checkout has no origin remote to connect.');
    return lines.join('\n');
  }
  lines.push('You can connect it to a project in a team you administer:');
  for (const t of adminOf) {
    const projects = Array.isArray(t.projects) ? t.projects : [];
    if (projects.length === 0) lines.push(`  nim wiki bind --org ${safeText(t.orgId)} --project <projectId>`);
    for (const p of projects) {
      lines.push(`  nim wiki bind --org ${safeText(t.orgId)} --project ${safeText(p.projectId)}   ${dim(safeText(String(p.projectName ?? '')))}`);
    }
    lines.push(`  nim wiki create-project --org ${safeText(t.orgId)} --name "<name>" --bind`);
  }
  lines.push(dim('Everyone in the team who can reach that project will see its pages.'));
  return lines.join('\n');
}

export async function runStatus(ctx: PagesCtx): Promise<number> {
  const res = await tool(ctx, 'pages_status');
  return print(ctx, res, () => renderStatus(ctx, res));
}

/**
 * `nim wiki pin --org --project`: records one of the projects this repository
 * actually resolves to. The status lookup deliberately omits `project`: asking
 * with the choice would only prove the user can reach it, and a pin to a
 * reachable project the repo is not connected to would send this repo's pages
 * somewhere else.
 */
export async function runPin(ctx: PagesCtx): Promise<number> {
  const choice = flagPin(ctx.args);
  if (!choice) throw usageError(`'nim wiki pin' requires --org <orgId> --project <projectId>.`);
  requireRepo(ctx);
  const res = await tool(ctx, 'pages_status');
  const candidates: ProjectRef[] =
    res?.state === 'ambiguous' && Array.isArray(res.projects) ? res.projects : res?.state === 'bound' && res.project ? [res.project] : [];
  const project = candidates.find((p) => p?.orgId && p?.projectId && sameProject(p, choice));
  if (!project) {
    throw usageError(
      candidates.length === 0
        ? `This repository is not connected to a team project you can reach, so there is nothing to pin. Run 'nim wiki status'.`
        : `This repository is not connected to project ${pinText(choice)}. It resolves to: ${candidates.map(pinText).join(', ')}. Run 'nim wiki status'.`,
    );
  }
  writeProjectPin(ctx.root, choice);
  return print(ctx, { pinned: choice, project }, () =>
    outputOptions(ctx.args).quiet
      ? pinText(choice)
      : `Pinned ${safeText(named(project.projectName, project.projectId))} in .nimbalyst/wiki.json. Commit it so teammates resolve the same project.`,
  );
}

function requireRepo(ctx: PagesCtx): string {
  const repo = ctx.base.repo;
  if (typeof repo !== 'string' || !repo) {
    throw usageError(`'nim wiki ${ctx.args.verb}' needs a repository: this checkout has no origin remote. Pass --repo.`);
  }
  return repo;
}

function projectOf(res: any): ProjectRef {
  return res?.project && typeof res.project === 'object' ? res.project : res ?? {};
}

/** `nim wiki bind --org --project`: admin only, enforced by the server. */
export async function runBind(ctx: PagesCtx): Promise<number> {
  const choice = flagPin(ctx.args);
  if (!choice) throw usageError(`'nim wiki bind' requires --org <orgId> --project <projectId>.`);
  const repo = requireRepo(ctx);
  const res = await tool(ctx, 'pages_bind_repo', { orgId: choice.orgId, projectId: choice.projectId }, { repo });
  const p = projectOf(res);
  return print(ctx, res, () =>
    renderObject({ projectId: p.projectId ?? choice.projectId, repo, project: named(p.projectName, p.projectId ?? choice.projectId), url: p.url }, outputOptions(ctx.args), 'projectId'),
  );
}

/** `nim wiki create-project --org --name [--bind]`: admin only, enforced by the server. */
export async function runCreateProject(ctx: PagesCtx): Promise<number> {
  const orgId = flagStr(ctx.args, 'org');
  const name = flagStr(ctx.args, 'name');
  if (!orgId || !name) throw usageError(`'nim wiki create-project' requires --org <orgId> --name <name>.`);
  const repo = flagBool(ctx.args, 'bind') ? requireRepo(ctx) : undefined;
  const res = await tool(ctx, 'pages_create_project', { orgId, name, repo }, {});
  const p = projectOf(res);
  return print(ctx, res, () =>
    renderObject(
      { projectId: p.projectId, team: named(p.orgName, p.orgId ?? orgId), project: named(p.projectName ?? name, p.projectId), bound: repo, url: p.url },
      outputOptions(ctx.args),
      'projectId',
    ),
  );
}
