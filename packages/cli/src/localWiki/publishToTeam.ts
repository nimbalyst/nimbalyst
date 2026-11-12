/**
 * Publishes the local wiki one way into a team project, for reviewers to read
 * and comment on: `nim wiki publish` and the `publishLocalWikiToTeam` MCP
 * tool. The local files stay the source of truth; the team copy is a mirror
 * that each publish brings up to date. It runs only when a person or an agent
 * runs it.
 *
 * It is the move's import (`collectLocalWiki` + `importToTeam`, upserting on
 * the wiki id and each page's local id) with what a reader must not see left
 * out (`export: false`, person fields), no `migratedTo` and no banner on the
 * local Home. The team Home gets one line saying where the pages come from.
 *
 * A page someone edited on the team side is refused by the server
 * (`body_edited`) and reported, never overwritten; `diffPublishedPage` shows
 * that edit against the local file so it can be merged and the next publish
 * lands.
 *
 * Removals (.claude/rules/destructive-data-paths.md): a page the previous
 * publish put in the team project and that is gone from the local wiki now
 * goes to team Trash (a typed page is archived; Trash holds only pages), only
 * after the rest of the publish verified, and only when its team body still
 * reads as what the publish wrote. Trash and Archive are the recoverable
 * artifact. The manifest records every candidate before anything is trashed,
 * and keeps the ones left in place, so a failure is retried and reported.
 */
import { statSync } from 'node:fs';
import * as path from 'node:path';
import { CliError, ExitCode } from '../cli/exitCodes.js';
import { resolveServer } from '../cloud/config.js';
import { loadCredentials } from '../cloud/credentials.js';
import { callTool } from '../cloud/pagesClient.js';
import { locateCheckout, resolveTeamsTarget, writeProjectPin, type ProjectPin } from '../cloud/repo.js';
import { openThreads, readPageComments } from '../cloud/teamComments.js';
import { createTeamContentWriter, type TeamContentWriter } from '../cloud/teamContent.js';
import { bodyDocumentId, importToTeam, pacedCaller, type ImportError, type ToolCaller } from '../cloud/teamImport.js';
import type { EditorModels, EditorModelsLoader } from '../mcp/editorTools.js';
import { readMigratedTo, readPublishTarget, writePublishTarget, type PublishTarget } from './locate.js';
import type { OpenedWiki } from './open.js';
import {
  hashText,
  readPublishManifest,
  writePublishManifest,
  PUBLISH_MANIFEST_VERSION,
  type PublishManifest,
  type PublishedPage,
} from './publishManifest.js';
import { collectLocalWiki, type CollectOptions, type ImportPage, type LocalWikiExport } from './teamExport.js';
import type { MoveDeps } from './moveToTeam.js';

export const PUBLISH_NOTE_PREFIX = 'Published from the local wiki in';

/** The line on the team Home. `where` names the repository (or the folder when there is no remote). */
export function publishNote(where: string): string {
  return `${PUBLISH_NOTE_PREFIX} ${where}. Each publish replaces these pages, so edits made here are not kept; leave a comment instead.`;
}

/** A remote without any credential it carries (`https://user:token@host/...`). */
function repoLabel(repo: string | undefined, fallback: string): string {
  if (!repo) return fallback;
  return repo.replace(/^(https?:\/\/)[^@/]+@/i, '$1');
}

/** The note line the team Home carries for this checkout. */
export function homeNoteFor(projectRoot: string): string {
  return publishNote(repoLabel(locateCheckout(projectRoot).origin, path.basename(projectRoot)));
}

export type PublishDeps = MoveDeps;

export interface PublishOptions {
  dryRun?: boolean;
  /** Remove more team pages than the guard allows (see REMOVAL_GUARD). */
  confirmRemovals?: boolean;
}

/**
 * Removals past this many need `confirmRemovals`: more than 3 pages and more
 * than 10% of what the last publish recorded. A branch checked out without
 * part of the wiki, or files whose ids were dropped, looks like many deletions.
 */
export function removalLimit(recorded: number): number {
  return Math.max(3, Math.floor(recorded * 0.1));
}

export interface InitOptions {
  /** Bind to (or pick) this existing project. */
  project?: ProjectPin;
  /** Create a project in this team when the repository has none. */
  orgId?: string;
  /** The new project's name; default the repository folder's name. */
  name?: string;
  dryRun?: boolean;
  confirmRemovals?: boolean;
}

export interface PageRef {
  localId: string;
  title: string;
  /** The page file, relative to the project root; null for a table row. */
  file: string | null;
  link?: string;
}

export interface OrphanedThread extends PageRef {
  threadId: string;
  quote: string;
  firstComment: string;
  author: string;
}

export interface RemovalOutcome extends PageRef {
  /** `pending`: more removals than the guard allows; publish again with confirmRemovals to carry them out. */
  action: 'trashed' | 'archived' | 'kept' | 'pending';
  /** Why a page was kept: edited on the team side, could not be checked, or the server refused. */
  reason?: string;
}

export interface PublishReport {
  dryRun: boolean;
  project: { orgId: string; projectId: string; projectName?: string } | null;
  counts: { pages: number; editorPages: number; typedPages: number; types: number; files: number; strippedFields: number };
  /** Pages left out: `export: false` (and what is under it), or editor pages this machine cannot write. */
  skipped: Array<{ title: string; reason: string }>;
  created?: number;
  updated?: number;
  unchanged?: number;
  /** Pages someone edited in the team project; not overwritten. Merge the edit into the file (diffPublishedPage), then publish again. */
  bodyEdited?: PageRef[];
  errors?: Array<ImportError & { title?: string }>;
  warnings?: Array<ImportError & { title?: string }>;
  /** Pages gone from the local wiki since the last publish, and what happened to each team copy. */
  removals?: RemovalOutcome[];
  /** Open threads whose quoted text is not in the page after this publish. */
  orphanedThreads?: OrphanedThread[];
  verified?: boolean;
  homeLink?: string;
  publishedAt?: string;
  notes: string[];
}

export class PublishRefusal extends CliError {
  constructor(message: string, readonly next?: string) {
    super(ExitCode.USAGE, message);
    this.name = 'PublishRefusal';
  }
}

async function editorModels(opened: OpenedWiki, load: EditorModelsLoader | undefined): Promise<{ models: EditorModels | null; editorTypes: CollectOptions['editorTypes']; unavailable?: string }> {
  if (!load) return { models: null, editorTypes: { unavailable: "the editors' document code is not available here" }, unavailable: "the editors' document code is not available here" };
  try {
    const models = await load(opened);
    return { models, editorTypes: new Set(models.editorCodecs.documentTypes) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: null, editorTypes: { unavailable: message }, unavailable: message };
  }
}

function signedInCaller(deps: PublishDeps, dryRun: boolean): ToolCaller | null {
  const server = resolveServer();
  if (!deps.call && !loadCredentials(server)) {
    if (dryRun) return null;
    throw new PublishRefusal('Not signed in to Nimbalyst Teams on this machine. Call teamSignIn (or run `nim login`), then try again.', 'teamSignIn');
  }
  return pacedCaller({ ...deps, call: deps.call ?? ((name, args) => callTool(server, name, args)) });
}

/** Hash of everything a publish sends for one page, to tell unchanged pages from updated ones. */
function sourceHash(page: ImportPage, exported: LocalWikiExport): string {
  // A linked file replaced under the same name changes the page too, so its upload is not skipped.
  const files = (exported.linkedFiles.get(page.localId) ?? []).map((file) => {
    if (!file.abs) return [file.linkPath, null];
    try {
      const stat = statSync(file.abs);
      return [file.linkPath, stat.size, stat.mtimeMs];
    } catch {
      return [file.linkPath, null];
    }
  });
  return hashText(JSON.stringify([page, exported.editorFiles.get(page.localId)?.text ?? null, exported.relations.get(page.localId) ?? null, files]));
}

function teamBodyText(result: any): string | null {
  return typeof result?.markdown === 'string' ? result.markdown : null;
}

/** Each page's file relative to the project root, by local id. */
async function pageFiles(opened: OpenedWiki): Promise<Map<string, string>> {
  const snapshot = await opened.wiki.snapshot();
  const files = new Map<string, string>();
  for (const page of snapshot.pages) {
    if (page.path) files.set(page.id, path.relative(opened.projectRoot, path.join(opened.dir, page.path)).split(path.sep).join('/'));
  }
  return files;
}

function refOf(localId: string, title: string, files: Map<string, string>, link?: string): PageRef {
  return { localId, title, file: files.get(localId) ?? null, ...(link ? { link } : {}) };
}

/** Removal order: deepest first, so a page's children leave before it does. */
function depthFirst(ids: string[], pages: Record<string, PublishedPage>): string[] {
  const depth = (id: string) => {
    let n = 0;
    const seen = new Set<string>();
    for (let at = pages[id]?.parentLocalId ?? null; at && !seen.has(at); at = pages[at]?.parentLocalId ?? null) {
      seen.add(at);
      n++;
    }
    return n;
  };
  return [...ids].sort((a, b) => depth(b) - depth(a));
}

/**
 * The publish. Needs the `publish` block (`nim wiki publish --init` writes
 * it); refuses a wiki that was moved to a team project.
 */
export async function publishLocalWikiToTeam(opened: OpenedWiki, options: PublishOptions = {}, deps: PublishDeps = {}): Promise<PublishReport> {
  const moved = readMigratedTo(opened.projectRoot);
  if (moved) {
    throw new PublishRefusal(
      `This local wiki was moved to team project ${moved.orgId}/${moved.projectId}; the team copy is where it is edited now, so there is nothing to publish. ` +
        'Remove `migratedTo` from .nimbalyst/local-wiki.json first if the files are meant to be the source again.',
    );
  }
  const target = readPublishTarget(opened.projectRoot);
  if (!target) {
    throw new PublishRefusal('This local wiki does not publish to a team project yet. Run `nim wiki publish --init` (or call publishLocalWikiToTeam with init: true) first.', 'init');
  }
  return runPublish(opened, target, options, deps);
}

/**
 * `--init`: binds the repository to a team project (the bound one, a chosen
 * one, or a new one when the user is a team admin), writes the `publish`
 * block, and runs the first publish.
 */
export async function initPublish(opened: OpenedWiki, options: InitOptions, deps: PublishDeps = {}): Promise<PublishReport> {
  const moved = readMigratedTo(opened.projectRoot);
  if (moved) throw new PublishRefusal(`This local wiki was moved to team project ${moved.orgId}/${moved.projectId}; it cannot also publish.`);
  const call = signedInCaller(deps, false)!;
  const checkout = locateCheckout(opened.projectRoot);
  const repo = checkout.origin;
  const existing = readPublishTarget(opened.projectRoot);
  const pin = options.project ?? existing;
  const status = await call('pages_status', { ...(repo ? { repo } : {}), ...(pin ? { project: { orgId: pin.orgId, projectId: pin.projectId } } : {}) });

  let project: ProjectPin | null = null;
  const sameAs = (p: any) => !pin || (p?.orgId === pin.orgId && p?.projectId === pin.projectId);
  const pinText = pin ? `${pin.orgId}/${pin.projectId}` : '';
  const pinSource = options.project ? 'requested' : 'recorded (the publish block in .nimbalyst/local-wiki.json)';
  const state = status?.state;
  if (state === 'bound' && status.project?.orgId && status.project?.projectId) {
    if (!sameAs(status.project)) {
      throw new PublishRefusal(`This repository is bound to team project ${status.project.orgId}/${status.project.projectId}, not the ${pinSource} project ${pinText}. Publish to the bound project, or have a team admin change the binding.`);
    }
    project = { orgId: String(status.project.orgId), projectId: String(status.project.projectId) };
  } else if (state === 'ambiguous') {
    const found = (status.projects ?? []).find((p: any) => pin && sameAs(p));
    if (!found) throw new PublishRefusal('This repository resolves to several team projects. Pass the one to publish to ({ orgId, projectId }, or --org and --project).', 'project');
    project = { orgId: String(found.orgId), projectId: String(found.projectId) };
    writeProjectPin(checkout.root, project);
  } else if (state !== 'unbound') {
    throw new PublishRefusal(`The server did not say this repository's team project (pages_status answered ${state === undefined ? 'nothing' : `"${String(state)}"`}), so nothing was created or bound. Check the sign-in with \`nim wiki status\`, then run --init again.`);
  } else if (options.project) {
    // An existing project the repository is not bound to: binding it is a team admin's call, which the server checks.
    if (!repo) throw new PublishRefusal(`Team project ${pinText} is not reachable from this checkout as you, and with no origin remote there is nothing to bind. Check the project id and your access in the console.`);
    if (options.dryRun) return { ...emptyReport(true), notes: [`Would bind ${repo} to ${options.project.orgId}/${options.project.projectId}, then publish.`] };
    await call('pages_bind_repo', { repo, orgId: options.project.orgId, projectId: options.project.projectId });
    project = options.project;
  } else if (existing) {
    // A recorded project that is not reachable now is never replaced by a new one: its pages, comments and reviewers are there.
    throw new PublishRefusal(
      `The ${pinSource} project ${pinText} is not reachable from this repository as you, so --init stops rather than create another project. ` +
        'Check the sign-in (`nim wiki status`) and your access to that project; to publish somewhere else on purpose, remove `publish` from .nimbalyst/local-wiki.json first.',
    );
  } else {
    const teams: any[] = Array.isArray(status?.teams) ? status.teams : [];
    const adminOf = teams.filter((team) => team?.role === 'admin' || team?.role === 'owner');
    const orgId = options.orgId ?? (adminOf.length === 1 ? String(adminOf[0].orgId) : undefined);
    if (!orgId) {
      throw new PublishRefusal(
        adminOf.length === 0
          ? 'This repository is not connected to a team project, and you are not an admin of a team that could create one. Ask a team admin to create the project and bind this repository, or to make you an admin.'
          : `This repository is not connected to a team project. Pass the team to create it in (--org, one of: ${adminOf.map((team) => team.orgId).join(', ')}), or an existing project (--org and --project).`,
        'team_create',
      );
    }
    const name = options.name ?? path.basename(checkout.root);
    if (options.dryRun) {
      return { ...emptyReport(true), notes: [`Would create team project "${name}" in ${orgId}${repo ? ` bound to ${repo}` : ''}, then publish.`] };
    }
    const created = await call('pages_create_project', { orgId, name, ...(repo ? { repo } : {}) });
    const p = created?.project ?? created;
    if (!p?.projectId) throw new PublishRefusal('The server did not return the new project.');
    project = { orgId: String(p.orgId ?? orgId), projectId: String(p.projectId) };
    // Without a remote to bind, the pin is how this checkout finds the project again.
    if (!repo) writeProjectPin(checkout.root, project);
  }

  if (options.dryRun) return runPublish(opened, { ...project }, { dryRun: true }, { ...deps, call });
  const publish: PublishTarget = existing && existing.orgId === project.orgId && existing.projectId === project.projectId ? existing : { ...project };
  writePublishTarget(opened.projectRoot, publish);
  return runPublish(opened, publish, { confirmRemovals: options.confirmRemovals }, { ...deps, call });
}

function emptyReport(dryRun: boolean): PublishReport {
  return { dryRun, project: null, counts: { pages: 0, editorPages: 0, typedPages: 0, types: 0, files: 0, strippedFields: 0 }, skipped: [], notes: [] };
}

async function runPublish(opened: OpenedWiki, target: PublishTarget, options: PublishOptions, deps: PublishDeps): Promise<PublishReport> {
  const { models, editorTypes, unavailable } = await editorModels(opened, deps.loadEditorModels);
  const wikiPrefix = path.relative(opened.projectRoot, opened.dir).split(path.sep).join('/');
  const exported = await collectLocalWiki(opened.wiki, { editorTypes, wikiPrefix, wikiDir: opened.dir, publish: true });
  // Nothing to publish reads as "every page was deleted"; never act on that.
  if (exported.pages.length === 0) {
    throw new PublishRefusal(`No pages to publish in ${opened.dir} (every page is left out, or the folder is empty), so nothing was sent and nothing was removed from the team project.`);
  }
  const typedPages = exported.pages.filter((page) => page.kind === 'typedPage').length;
  const editorPages = exported.editorFiles.size;
  const report: PublishReport = {
    dryRun: options.dryRun === true,
    project: null,
    counts: {
      pages: exported.pages.length - typedPages - editorPages,
      editorPages,
      typedPages,
      types: exported.types.length,
      files: [...exported.linkedFiles.values()].reduce((n, list) => n + list.filter((file) => file.abs).length, 0),
      strippedFields: exported.strippedFields,
    },
    skipped: exported.skipped.map(({ title, reason }) => ({ title, reason })),
    notes: [],
  };

  const call = signedInCaller(deps, report.dryRun);
  if (!call) return { ...report, notes: ['Not signed in to Nimbalyst Teams yet, so the target project was not checked. Call teamSignIn (or run nim login).'] };
  const checkout = locateCheckout(opened.projectRoot);
  const project = { orgId: target.orgId, projectId: target.projectId };
  const teams = resolveTeamsTarget(opened.projectRoot, { project, ...(checkout.origin ? { repo: checkout.origin } : {}) });
  const base = { ...(teams.repo ? { repo: teams.repo } : {}), project };
  const status = await call('pages_status', base);
  if (status?.state !== 'bound' || status.project?.orgId !== project.orgId || status.project?.projectId !== project.projectId) {
    throw new PublishRefusal(
      `The publish target ${project.orgId}/${project.projectId} (the publish block in .nimbalyst/local-wiki.json) is not reachable from this repository as you. ` +
        'Check the sign-in (nim wiki status), or run `nim wiki publish --init` to choose the project again.',
    );
  }
  report.project = { ...project, ...(status.project.projectName ? { projectName: String(status.project.projectName) } : {}) };

  const wikiId = await opened.wiki.wikiId();
  const previous = readPublishManifest(opened.projectRoot, { ...project, wikiId });
  const files = await pageFiles(opened);
  const titles = new Map(exported.pages.map((page) => [page.localId, page.title]));
  const present = new Set(exported.pages.map((page) => page.localId));
  // Still in the wiki, so not removals: an editor page this machine cannot write, and a file that does not
  // parse (the scanner gives it a derived id, so its recorded page is matched by path, or by type for a table row).
  const heldBack = new Set(exported.skipped.filter((page) => !page.excluded).map((page) => page.localId));
  const malformedPaths = new Set(exported.malformed.paths.map((p) => p.toLowerCase()));
  const malformedTables = new Set(exported.malformed.tableTypes);
  const isHeldBack = (id: string, entry: PublishedPage) =>
    heldBack.has(id) ||
    (malformedPaths.size > 0 && (entry.path === undefined ? entry.kind !== 'typedPage' || entry.underType !== true : malformedPaths.has(entry.path.toLowerCase()))) ||
    (malformedTables.size > 0 && entry.kind === 'typedPage' && (entry.typeId === undefined || malformedTables.has(entry.typeId)));
  const previousIds = Object.keys(previous?.pages ?? {}).filter((id) => !present.has(id));
  const carried = previousIds.filter((id) => isHeldBack(id, previous!.pages[id]));
  const removedIds = previousIds.filter((id) => !carried.includes(id));
  const limit = removalLimit(Object.keys(previous?.pages ?? {}).length);
  const removalsHeld = removedIds.length > limit && options.confirmRemovals !== true;
  const confirmHint = `${removedIds.length} team pages would be removed, over the limit of ${limit} for one publish. If those local pages really were deleted, publish again with --confirm-removals (MCP: confirmRemovals: true).`;

  if (report.dryRun) {
    report.removals = removedIds.map((id) => ({
      ...refOf(id, previous!.pages[id].title, files, previous!.pages[id].link),
      action: removalsHeld ? 'pending' as const : 'kept' as const,
      reason: removalsHeld ? 'over the removal limit' : 'dry run: would go to team Trash unless edited there',
    }));
    if (removalsHeld) report.notes.push(confirmHint);
    return { ...report, homeLink: typeof status.homeLink === 'string' ? status.homeLink : undefined };
  }

  // The team Home says where its pages come from.
  // Only the local page that becomes the team Home (a top-level page titled Home); with none in this publish
  // (left out, or its file does not parse) the team Home is not touched.
  const homeId = exported.projectHomeLocalId;
  const home = homeId ? exported.pages.find((page) => page.localId === homeId) : undefined;
  if (home) home.body = `${homeNoteFor(opened.projectRoot)}\n\n${home.body}`;

  const needsContent = exported.editorFiles.size > 0 || exported.linkedFiles.size > 0;
  const server = resolveServer();
  const content: TeamContentWriter | undefined = deps.content ?? (needsContent || models ? createTeamContentWriter({ server, call, base, models }) : undefined);
  // Links to pages an earlier publish created go out in team form in the first write, so the bytes the server
  // compares are the team text: an unchanged page is not rewritten, and a merged one is taken.
  const prior = Object.fromEntries(
    Object.entries(previous?.pages ?? {}).map(([id, entry]) => [id, { nodeId: entry.nodeId, id: entry.id, link: entry.link, ...(entry.uri ? { uri: entry.uri } : {}) }]),
  );
  // A republish sends only the pages whose source changed since the last verified publish (and, inside
  // importToTeam, those whose links now reach a new page); the rest are already in the team as recorded.
  const hashes = new Map(exported.pages.map((page) => [page.localId, sourceHash(page, exported)]));
  const only = previous
    ? new Set(exported.pages.filter((page) => {
        const before = previous.pages[page.localId];
        return !before || before.removedLocally || before.sourceHash !== hashes.get(page.localId);
      }).map((page) => page.localId))
    : undefined;
  const outcome = await importToTeam(exported, { repo: teams.repo, project, wikiId, prior, ...(only ? { only } : {}) }, call, content);

  const bodyEditedIds = new Set(outcome.errors.filter((error) => error.code === 'body_edited').map((error) => error.localId));
  const unchanged = exported.pages.filter((page) => {
    if (only) return !outcome.sentIds.has(page.localId) && Boolean(outcome.idMap[page.localId]);
    const before = previous?.pages[page.localId];
    return before && !before.removedLocally && before.sourceHash === hashes.get(page.localId) && !bodyEditedIds.has(page.localId) && outcome.idMap[page.localId];
  }).length;
  const otherErrors = outcome.errors.filter((error) => error.code !== 'body_edited');
  Object.assign(report, {
    created: outcome.created,
    updated: only ? outcome.updated : Math.max(0, outcome.updated - unchanged),
    unchanged,
    bodyEdited: [...bodyEditedIds].map((id) => refOf(id, titles.get(id) ?? id, files, outcome.idMap[id]?.link)),
    errors: otherErrors.map((error) => ({ ...error, title: titles.get(error.localId) })),
    warnings: outcome.warnings.map((warning) => ({ ...warning, title: titles.get(warning.localId) })),
  });
  const homeEntry = homeId ? outcome.idMap[homeId] : undefined;
  report.homeLink = homeEntry?.link ?? (typeof status.homeLink === 'string' ? status.homeLink : undefined);

  // Verified: every page has its team id, and nothing failed but pages edited on the team side.
  let verified = otherErrors.length === 0 && exported.pages.every((page) => outcome.idMap[page.localId]);
  const readBody = async (uri: string): Promise<string | null> => {
    try {
      return teamBodyText(await call('readCollabDoc', { ...base, filePath: uri }));
    } catch {
      return null;
    }
  };
  // A readback is the outside check that the publish landed: the team Home when this publish wrote it, else
  // the first published markdown page. Removals wait on it.
  if (verified) {
    if (homeEntry) {
      verified = (await readBody(homeEntry.uri ?? homeEntry.link)) !== null;
      if (!verified) report.notes.push("The team project's Home did not read back after the publish.");
    } else {
      report.notes.push('This publish has no Home page (the local Home is left out or its file does not parse), so the team Home was not written or checked; another published page was read back instead.');
      const probe = exported.pages.find((page) => page.kind !== 'editorPage' && outcome.idMap[page.localId]);
      const entry = probe ? outcome.idMap[probe.localId] : undefined;
      verified = Boolean(entry) && (await readBody(entry!.uri ?? entry!.link)) !== null;
      if (!verified) report.notes.push(`"${probe?.title ?? 'A published page'}" did not read back after the publish.`);
    }
  }
  report.verified = verified;
  if (!verified) {
    report.notes.push('The publish is not verified, so nothing was removed from the team project and the publish record was not updated. Fix the errors, then publish again; it resumes.');
    return report;
  }

  // The record: what each page is in the team now, and what its body reads as there.
  const publishedAt = (deps.clock?.() ?? new Date()).toISOString();
  const pages: Record<string, PublishedPage> = {};
  for (const page of exported.pages) {
    const entry = outcome.idMap[page.localId]!;
    const before = previous?.pages[page.localId];
    const hash = hashes.get(page.localId)!;
    let teamBodyHash = before?.teamBodyHash;
    if (page.kind === 'editorPage') teamBodyHash = undefined;
    // A body edited on the team side keeps the hash of what the publish last wrote, so it still reads as edited.
    else if (!bodyEditedIds.has(page.localId) && (outcome.sentIds.has(page.localId) || !teamBodyHash)) {
      const text = await readBody(entry.uri ?? entry.link);
      teamBodyHash = text === null ? undefined : hashText(text);
    }
    pages[page.localId] = {
      nodeId: entry.nodeId,
      id: entry.id,
      documentId: bodyDocumentId(entry),
      kind: page.kind,
      title: page.title,
      parentLocalId: page.parentLocalId,
      ...(exported.locations.get(page.localId)?.path ? { path: exported.locations.get(page.localId)!.path! } : {}),
      ...(page.typeId ? { typeId: page.typeId } : {}),
      ...(page.underType ? { underType: true as const } : {}),
      link: entry.link,
      ...(entry.uri ? { uri: entry.uri } : {}),
      // A body the team refused (edited there) keeps the old hash, so the next publish sends it again and reports it.
      sourceHash: bodyEditedIds.has(page.localId) ? before?.sourceHash ?? '' : hash,
      ...(teamBodyHash ? { teamBodyHash } : {}),
    };
  }
  // Recorded before anything is trashed, so an interrupted removal is retried by the next publish.
  for (const id of removedIds) pages[id] = { ...previous!.pages[id], removedLocally: true };
  // Held back this time (a malformed file, an editor page this machine cannot write): kept as recorded.
  for (const id of carried) pages[id] = previous!.pages[id];
  const manifest: PublishManifest = { version: PUBLISH_MANIFEST_VERSION, ...project, wikiId, publishedAt, pages };
  writePublishManifest(opened.projectRoot, manifest);

  report.removals = [];
  if (removalsHeld) {
    for (const id of removedIds) report.removals.push({ ...refOf(id, pages[id].title, files, pages[id].link), action: 'pending', reason: 'over the removal limit; nothing was removed' });
    report.notes.push(confirmHint);
  }
  for (const id of removalsHeld ? [] : depthFirst(removedIds, pages)) {
    const entry = pages[id];
    const ref = refOf(id, entry.title, files, entry.link);
    const keep = (reason: string) => report.removals!.push({ ...ref, action: 'kept', reason });
    if (entry.id.startsWith('home:')) {
      keep("it is the team project's Home, which is never removed");
      continue;
    }
    if (!entry.teamBodyHash) {
      keep('its team copy could not be checked for edits made there (an editor page, or its body was not readable at the last publish); remove it in the team project if it should go');
      continue;
    }
    const now = await readBody(entry.uri ?? entry.link);
    if (now === null) {
      keep('its team copy could not be read, so it was not checked for edits');
      continue;
    }
    if (hashText(now) !== entry.teamBodyHash) {
      keep('someone edited it in the team project since the last publish');
      continue;
    }
    try {
      if (entry.nodeId.startsWith('item:')) {
        await call('tracker_update', { ...base, id: entry.id, archived: true });
        report.removals.push({ ...ref, action: 'archived' });
      } else {
        const result = await call('deleteSharedItem', { ...base, itemId: entry.id, kind: 'doc' });
        if (result?.trashed !== true) throw new Error('the server did not confirm the page went to Trash');
        report.removals.push({ ...ref, action: 'trashed' });
      }
      delete pages[id];
    } catch (err) {
      keep(`the server refused it: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  writePublishManifest(opened.projectRoot, manifest);
  writePublishTarget(opened.projectRoot, { ...target, publishedAt });
  report.publishedAt = publishedAt;

  // Threads on rewritten pages whose quote is gone: the agent resolves or answers them.
  const rewritten = exported.pages.filter(
    (page) => page.kind !== 'editorPage' && !bodyEditedIds.has(page.localId) && previous?.pages[page.localId]?.sourceHash !== hashes.get(page.localId) && previous?.pages[page.localId],
  );
  if (rewritten.length) {
    if (!content?.readRoom || !models) {
      report.notes.push(`Comment anchors on the ${rewritten.length} rewritten pages were not checked: ${unavailable ?? "the editors' document code is not available"}.`);
    } else {
      report.orphanedThreads = [];
      for (const page of rewritten) {
        const entry = pages[page.localId];
        const read = await content.readRoom(entry.documentId, readPageComments);
        if (!read.ok) {
          report.notes.push(`The comments on "${page.title}" could not be read: ${read.message}`);
          continue;
        }
        for (const thread of openThreads(read.value)) {
          if (thread.anchorState !== 'orphaned') continue;
          report.orphanedThreads.push({
            ...refOf(page.localId, page.title, files, entry.link),
            threadId: thread.id,
            quote: thread.quote,
            firstComment: thread.comments[0].content,
            author: thread.comments[0].author,
          });
        }
      }
    }
  }
  return report;
}
