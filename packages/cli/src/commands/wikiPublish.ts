/**
 * `nim wiki publish [--init [--org <id>] [--project <id>] [--name <n>]] [--dry-run] [--confirm-removals] [--json]`,
 * `nim wiki comments [<page>] [--json]` and `nim wiki publish-diff <page> [--json]`
 * for a local wiki that publishes to a team project. See
 * localWiki/publishToTeam.ts and localWiki/publishedComments.ts; the
 * `publishLocalWikiToTeam`, `listPublishedComments` and `diffPublishedPage`
 * MCP tools run the same code.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagStr } from '../cli/parse.js';
import { ExitCode, usageError } from '../cli/exitCodes.js';
import { safeText } from '../cli/output.js';
import { initPublish, publishLocalWikiToTeam, type PublishReport } from '../localWiki/publishToTeam.js';
import { diffPublishedPage, listPublishedComments, type CommentsReport } from '../localWiki/publishedComments.js';
import { editorModelsFromWikiWeb } from '../mcp/editorTools.js';
import type { OpenedWiki } from '../localWiki/open.js';

const where = (ref: { title: string; file: string | null }) => safeText(ref.file ?? ref.title);

export function describePublish(report: PublishReport): string {
  const { counts } = report;
  const target = report.project ? `${report.project.projectName ?? report.project.projectId} (${report.project.orgId})` : 'no project checked';
  const lines = [
    `${report.dryRun ? 'Would publish' : 'Published'} ${counts.pages} pages, ${counts.editorPages} editor pages and ${counts.typedPages} typed pages to ${safeText(target)}`,
  ];
  if (report.skipped.length) lines.push(`Left out: ${report.skipped.map((s) => `${safeText(s.title)} (${s.reason})`).join(', ')}`);
  if (counts.strippedFields) lines.push(`Person fields left out: ${counts.strippedFields}`);
  if (!report.dryRun && report.created !== undefined) {
    lines.push(`${report.created} created, ${report.updated ?? 0} updated, ${report.unchanged ?? 0} unchanged`);
  }
  for (const page of report.bodyEdited ?? []) {
    lines.push(
      `  edited in the team, not overwritten: ${where(page)}. 'nim wiki publish-diff ${safeText(page.localId)}' shows the team text against the file; ` +
        'once the file holds the team text exactly (publish-diff shows no difference), the next publish takes the page back, and later edits to the file publish again',
    );
  }
  for (const error of report.errors ?? []) lines.push(`  error: ${safeText(error.title ?? error.localId)}: ${safeText(error.message)} (${error.code})`);
  for (const warning of report.warnings ?? []) lines.push(`  left as written: ${safeText(warning.title ?? warning.localId)}: ${safeText(warning.message)}`);
  for (const removal of report.removals ?? []) {
    lines.push(
      removal.action === 'kept' || removal.action === 'pending'
        ? `  removed locally, team copy ${removal.action === 'pending' ? 'not removed yet' : 'kept'}: ${safeText(removal.title)}: ${safeText(removal.reason ?? '')}`
        : `  removed locally, team copy ${removal.action === 'trashed' ? 'moved to Trash' : 'archived'}: ${safeText(removal.title)}`,
    );
  }
  for (const thread of report.orphanedThreads ?? []) {
    lines.push(`  comment lost its quote: ${where(thread)}: "${safeText(thread.quote)}" (${safeText(thread.author)}: ${safeText(thread.firstComment)})`);
  }
  if (report.homeLink) lines.push(`Home: ${report.homeLink}`);
  for (const note of report.notes) lines.push(note);
  return lines.join('\n');
}

function describeComments(report: CommentsReport): string {
  if (!report.threads.length) return `No open comment threads on ${report.pagesChecked} published pages.${report.notes.length ? `\n${report.notes.join('\n')}` : ''}`;
  const lines: string[] = [];
  for (const thread of report.threads) {
    lines.push(`${where(thread)}  [${thread.anchorState}]  "${safeText(thread.quote)}"`);
    for (const comment of thread.comments) lines.push(`  ${safeText(comment.author)}${comment.byAgent ? ' (agent)' : ''}: ${safeText(comment.content)}`);
  }
  lines.push(...report.notes);
  return lines.join('\n');
}

export async function runPublish(args: ParsedArgs, opened: OpenedWiki, version: string): Promise<number> {
  const deps = { loadEditorModels: editorModelsFromWikiWeb({ assetsDir: flagStr(args, 'assets'), version }) };
  const dryRun = flagBool(args, 'dry-run');
  let report: PublishReport;
  if (flagBool(args, 'init')) {
    const org = flagStr(args, 'org');
    const project = flagStr(args, 'project');
    report = await initPublish(opened, { project: org && project ? { orgId: org, projectId: project } : undefined, orgId: org, name: flagStr(args, 'name'), dryRun, confirmRemovals: flagBool(args, 'confirm-removals') }, deps);
  } else {
    if (flagStr(args, 'org') || flagStr(args, 'project') || flagStr(args, 'name')) throw usageError('--org, --project and --name go with --init.');
    report = await publishLocalWikiToTeam(opened, { dryRun, confirmRemovals: flagBool(args, 'confirm-removals') }, deps);
  }
  process.stdout.write((flagBool(args, 'json') ? JSON.stringify(report, null, 2) : describePublish(report)) + '\n');
  return report.verified === false ? ExitCode.CONNECTION : ExitCode.OK;
}

export async function runComments(args: ParsedArgs, opened: OpenedWiki, version: string): Promise<number> {
  const report = await listPublishedComments(opened, { page: args.positionals[0] }, { loadEditorModels: editorModelsFromWikiWeb({ assetsDir: flagStr(args, 'assets'), version }) });
  process.stdout.write((flagBool(args, 'json') ? JSON.stringify(report, null, 2) : describeComments(report)) + '\n');
  return ExitCode.OK;
}

export async function runPublishDiff(args: ParsedArgs, opened: OpenedWiki): Promise<number> {
  const ref = args.positionals[0];
  if (!ref) throw usageError('nim wiki publish-diff needs a page: an id, a path in the wiki, or a title');
  const result = await diffPublishedPage(opened, ref);
  process.stdout.write((flagBool(args, 'json') ? JSON.stringify(result, null, 2) : result.identical ? `The team text of ${where(result)} matches the file.` : result.diff.trimEnd()) + '\n');
  return ExitCode.OK;
}
