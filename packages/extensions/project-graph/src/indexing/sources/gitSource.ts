/**
 * Commit headers across all refs, paged; file evidence on demand.
 *
 * The legacy adapter ran one `git log -n 500 --name-only` on HEAD. That is two
 * separate limitations: 500 of ~5,800 reachable commits, and HEAD only, so work
 * on any other branch was invisible. Here the headers are lightweight (no
 * `--name-only`) and paged with `--skip`, and `--all` covers every ref.
 *
 * File and directory evidence is NOT part of the header pass. `--name-only`
 * across a full history is the expensive part, so it is fetched on demand — for
 * one commit, or for a bounded window — and the partial nature of that coverage
 * is reported rather than implied.
 */
import type { ProjectGraphNode } from '../../types';
import type { IndexPage, IndexSource, SourcePrepareResult } from '../types';
import { shellQuote } from '../../adapters/fileEnumeration';

const HEADER_FORMAT = '%H%x1F%s%x1F%an%x1F%aI';
const COMMIT_MARKER = '__COMMIT__';

export function createGitSource(): IndexSource {
  return {
    id: 'git',
    label: 'Git commits',

    async prepare(ctx): Promise<SourcePrepareResult> {
      const inside = await ctx.host.exec('git rev-parse --is-inside-work-tree', { timeout: 5000 });
      if (!inside.success || !/true/.test(inside.stdout)) {
        return { availability: 'unavailable', message: 'Not a git repository.', total: null };
      }
      // `rev-list --count --all` is a single walk and gives an authoritative
      // denominator, so coverage can say "N of M" rather than "N, of unknown".
      const count = await ctx.host.exec('git rev-list --count --all --no-merges', { timeout: 20000 });
      const total = count.success ? parseCount(count.stdout) : null;
      return {
        availability: 'available',
        total,
        scope: 'Non-merge commit headers across every ref. File evidence is fetched on demand.',
        // The only source that can answer a windowed event query; every other
        // one indexes metadata and has no event history to retrieve.
        eventSupport: 'window',
      };
    },

    async page(ctx, cursor, pageSize): Promise<IndexPage> {
      const skip = cursor ? Number(cursor) : 0;
      const log = await ctx.host.exec(
        `git log --all --no-merges --skip=${skip} -n ${pageSize} --pretty=format:${shellQuote(`${COMMIT_MARKER}${HEADER_FORMAT}`)}`,
        { timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      );
      ctx.signal.throwIfCancelled();
      if (!log.success) {
        throw new Error((log.stderr || `git log exited ${log.exitCode}`).slice(0, 200));
      }

      const records = parseCommitHeaders(log.stdout);
      return {
        records,
        edges: [],
        cursor: records.length === pageSize ? String(skip + records.length) : undefined,
        rows: records.length,
      };
    },

    owns(nodeId) {
      return nodeId.startsWith('commit:');
    },

    /** The commit's full message. `-s` suppresses the diff; this is not a body fetch. */
    async loadDetail(ctx, nodeId) {
      const sha = nodeId.slice('commit:'.length);
      const res = await ctx.host.exec(`git show -s --format=%B ${shellQuote(sha)}`, { timeout: 10000 });
      if (!res.success) return null;
      return { body: res.stdout.trim(), truncated: false };
    },

    async resolve(ctx, nodeId) {
      const sha = nodeId.slice('commit:'.length);
      // `-s` suppresses the diff; this is a header lookup, not a body fetch.
      const res = await ctx.host.exec(
        `git show -s --pretty=format:${shellQuote(`${COMMIT_MARKER}${HEADER_FORMAT}`)} ${shellQuote(sha)}`,
        { timeout: 10000 },
      );
      if (!res.success) return null;
      return parseCommitHeaders(res.stdout)[0] ?? null;
    },
  };
}

export { loadCommitFileEvidence } from './commitEvidence';

function parseCommitHeaders(stdout: string): ProjectGraphNode[] {
  const out: ProjectGraphNode[] = [];
  for (const block of stdout.split(COMMIT_MARKER)) {
    const header = block.split('\n')[0];
    if (!header) continue;
    const [hash, subject, author, isoDate] = header.split('\x1F');
    if (!hash) continue;
    const createdAt = isoDate ? Date.parse(isoDate) : NaN;
    out.push({
      id: `commit:${hash}`,
      type: 'commit',
      label: hash.slice(0, 7),
      sublabel: subject?.slice(0, 60),
      category: 'delivery',
      source: 'git',
      visibility: 'workspace-shared',
      createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
      fields: { hash, subject, author, isoDate, path: hash },
    });
  }
  return out;
}

function parseCount(stdout: string): number | null {
  const n = Number(stdout.trim());
  return Number.isFinite(n) ? n : null;
}
