/**
 * Feedback on a published wiki, back to the files: `nim wiki comments` and the
 * `listPublishedComments` MCP tool list every open thread on the published
 * pages with the local file it belongs to, the quoted text, its anchor state
 * and who wrote it; `nim wiki publish-diff` and `diffPublishedPage` show a
 * page edited on the team side against the local file, so the edit can be
 * merged into the file and the next publish lands.
 *
 * Threads are read from each page's team document (the publish manifest says
 * which), through the editors' room client; see cloud/teamComments.ts.
 */
import * as path from 'node:path';
import { resolveServer } from '../cloud/config.js';
import { loadCredentials } from '../cloud/credentials.js';
import { callTool } from '../cloud/pagesClient.js';
import { locateCheckout } from '../cloud/repo.js';
import { openThreads, readPageComments, type AnchorState } from '../cloud/teamComments.js';
import { assetUriFor, createTeamContentWriter } from '../cloud/teamContent.js';
import { pacedCaller, type ToolCaller } from '../cloud/teamImport.js';
import { readPublishTarget } from './locate.js';
import type { OpenedWiki } from './open.js';
import { readPublishManifest, type PublishManifest } from './publishManifest.js';
import { homeNoteFor, PublishRefusal, type PublishDeps } from './publishToTeam.js';
import { collectLocalWiki, pathIndex } from './teamExport.js';
import { teamForm, type ImportedEntry } from '../cloud/teamImport.js';
import { readFile } from 'node:fs/promises';
import { findPage } from './tree.js';

export interface PublishedThread {
  localId: string;
  title: string;
  /** The page file, relative to the project root; null when the page has no file (a table row) or is gone locally. */
  file: string | null;
  link: string;
  threadId: string;
  quote: string;
  anchorState: AnchorState;
  comments: Array<{ author: string; at: string; content: string; byAgent: boolean }>;
}

export interface CommentsReport {
  project: { orgId: string; projectId: string };
  pagesChecked: number;
  threads: PublishedThread[];
  notes: string[];
}

interface Context {
  manifest: PublishManifest;
  call: ToolCaller;
  base: Record<string, unknown>;
  server: string;
}

async function publishedContext(opened: OpenedWiki, deps: PublishDeps): Promise<Context> {
  const target = readPublishTarget(opened.projectRoot);
  if (!target) throw new PublishRefusal('This local wiki does not publish to a team project. Run `nim wiki publish --init` first.', 'init');
  const wikiId = await opened.wiki.wikiId();
  const manifest = readPublishManifest(opened.projectRoot, { orgId: target.orgId, projectId: target.projectId, wikiId });
  if (!manifest) throw new PublishRefusal('There is no record of a verified publish to this project yet. Run `nim wiki publish` first.');
  const server = resolveServer();
  if (!deps.call && !loadCredentials(server)) {
    throw new PublishRefusal('Not signed in to Nimbalyst Teams on this machine. Call teamSignIn (or run `nim login`), then try again.', 'teamSignIn');
  }
  const call = pacedCaller({ ...deps, call: deps.call ?? ((name, args) => callTool(server, name, args)) });
  const repo = locateCheckout(opened.projectRoot).origin;
  return { manifest, call, server, base: { ...(repo ? { repo } : {}), project: { orgId: target.orgId, projectId: target.projectId } } };
}

async function filesById(opened: OpenedWiki): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const page of (await opened.wiki.snapshot()).pages) {
    if (page.path && page.trashedAt === null) files.set(page.id, path.relative(opened.projectRoot, path.join(opened.dir, page.path)).split(path.sep).join('/'));
  }
  return files;
}

export async function listPublishedComments(opened: OpenedWiki, options: { page?: string } = {}, deps: PublishDeps = {}): Promise<CommentsReport> {
  const ctx = await publishedContext(opened, deps);
  let models;
  try {
    if (!deps.loadEditorModels) throw new Error("the editors' document code is not available here");
    models = await deps.loadEditorModels(opened);
  } catch (err) {
    if (!deps.content?.readRoom) {
      throw new PublishRefusal(`Comments are read from each page's team document with the editors' room client, which is not available: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const content = deps.content ?? createTeamContentWriter({ server: ctx.server, call: ctx.call, base: ctx.base, models: models ?? null });
  const files = await filesById(opened);
  let ids = Object.keys(ctx.manifest.pages).filter((id) => ctx.manifest.pages[id].kind !== 'editorPage');
  if (options.page) {
    const page = findPage(await opened.wiki.snapshot(), options.page);
    if (!ctx.manifest.pages[page.id]) throw new PublishRefusal(`"${page.title}" has not been published yet.`);
    ids = [page.id];
  }
  const report: CommentsReport = { project: { orgId: ctx.manifest.orgId, projectId: ctx.manifest.projectId }, pagesChecked: 0, threads: [], notes: [] };
  for (const id of ids) {
    const entry = ctx.manifest.pages[id];
    const read = await content.readRoom!(entry.documentId, readPageComments);
    if (!read.ok) {
      report.notes.push(`The comments on "${entry.title}" could not be read: ${read.message}`);
      continue;
    }
    report.pagesChecked++;
    for (const thread of openThreads(read.value)) {
      report.threads.push({
        localId: id,
        title: entry.title,
        file: files.get(id) ?? null,
        link: entry.link,
        threadId: thread.id,
        quote: thread.quote,
        anchorState: thread.anchorState,
        comments: thread.comments.map((c) => ({ author: c.author, at: new Date(c.at).toISOString(), content: c.content, byAgent: c.byAgent })),
      });
    }
  }
  return report;
}

export interface PageDiff {
  localId: string;
  title: string;
  file: string | null;
  link: string;
  /** Unified diff, local file (`-`) to team text (`+`); empty when they match. */
  diff: string;
  identical: boolean;
}

/** Line diff of `a` (local) against `b` (team), with `context` lines around each change. */
export function unifiedDiff(a: string, b: string, labels: { from: string; to: string }, context = 3): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 25_000_000) return `--- ${labels.from}\n+++ ${labels.to}\n(too long to diff line by line: ${n} and ${m} lines)\n`;
  // LCS lengths from the end.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: Array<{ op: ' ' | '-' | '+'; line: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ op: ' ', line: x[i], ai: i++, bi: j++ });
    // Deletions before insertions, as diff tools show a changed line.
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ op: '-', line: x[i], ai: i++, bi: j });
    else ops.push({ op: '+', line: y[j], ai: i, bi: j++ });
  }
  const changed = ops.map((o, k) => (o.op !== ' ' ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return '';
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) end = Math.min(ops.length - 1, changed[++k] + context);
    k++;
    const hunk = ops.slice(start, end + 1);
    const aLen = hunk.filter((o) => o.op !== '+').length;
    const bLen = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${hunk[0].ai + 1},${aLen} +${hunk[0].bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
  }
  return out.join('\n') + '\n';
}

/**
 * The team text of one published page against its local body in the form a
 * publish sends it: links to other published pages as their team links, file
 * links as their uploads, the publish note on Home. A file that holds the
 * team text exactly shows no difference, and the next publish takes the page.
 */
export async function diffPublishedPage(opened: OpenedWiki, ref: string, deps: PublishDeps = {}): Promise<PageDiff> {
  const ctx = await publishedContext(opened, deps);
  const page = findPage(await opened.wiki.snapshot(), ref);
  const entry = ctx.manifest.pages[page.id];
  if (!entry) throw new PublishRefusal(`"${page.title}" has not been published yet.`);
  if (entry.kind === 'editorPage') throw new PublishRefusal(`"${page.title}" is a ${page.documentType} page; only markdown pages can be compared as text.`);
  const team = await ctx.call('readCollabDoc', { ...ctx.base, filePath: entry.uri ?? entry.link });
  const teamText = typeof team?.markdown === 'string' ? team.markdown : '';
  const local = await localTeamForm(opened, page.id, ctx.manifest);
  const file = (await filesById(opened)).get(page.id) ?? null;
  const diff = unifiedDiff(local, teamText, { from: file ?? page.title, to: `team: ${entry.link}` });
  return { localId: page.id, title: page.title, file, link: entry.link, diff, identical: diff === '' };
}

/** A page's body as the next publish would send it, with team ids from the manifest. */
async function localTeamForm(opened: OpenedWiki, localId: string, manifest: PublishManifest): Promise<string> {
  const wikiPrefix = path.relative(opened.projectRoot, opened.dir).split(path.sep).join('/');
  // Comparing markdown needs the published editor pages' locations and file
  // extensions for embed rewrites, but never their codecs or a room write.
  const editorTypes = new Set((await opened.wiki.snapshot()).pages
    .filter((page) => manifest.pages[page.id]?.kind === 'editorPage')
    .map((page) => page.documentType));
  const exported = await collectLocalWiki(opened.wiki, { wikiPrefix, wikiDir: opened.dir, publish: true, editorTypes });
  const page = exported.pages.find((p) => p.localId === localId);
  if (!page) return (await opened.wiki.readBody(localId)).markdown;
  const homeId = exported.projectHomeLocalId;
  const body = homeId === localId ? `${homeNoteFor(opened.projectRoot)}\n\n${page.body}` : page.body;
  const entryFor = (id: string): ImportedEntry | undefined => {
    const recorded = manifest.pages[id];
    return recorded && !recorded.removedLocally ? { nodeId: recorded.nodeId, id: recorded.id, link: recorded.link, ...(recorded.uri ? { uri: recorded.uri } : {}) } : undefined;
  };
  // An upload's uri is derived from the file's bytes and the page's team document, so it is known without uploading.
  const assets = new Map<string, string>();
  for (const linked of exported.linkedFiles.get(localId) ?? []) {
    if (!linked.abs) continue;
    try {
      assets.set(linked.linkPath, assetUriFor(manifest.pages[localId].documentId, await readFile(linked.abs)));
    } catch {
      // A file that cannot be read stays as written, as the publish leaves it.
    }
  }
  return teamForm(exported, { ...page, body }, pathIndex(exported.locations), {
    entryFor,
    linkFor: (id) => entryFor(id)?.link,
    orgId: manifest.orgId,
    assetUri: (linkPath) => assets.get(linkPath),
  }).body;
}
