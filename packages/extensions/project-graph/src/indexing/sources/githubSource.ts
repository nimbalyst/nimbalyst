/**
 * GitHub pull requests and issues, paged through the REST API via `gh api`.
 *
 * Two things the legacy adapter got wrong are fixed here:
 *
 *  - **`gh … 2>/dev/null || true` turned every failure into an empty success.**
 *    An unauthenticated `gh`, a rate limit, and a repository with no pull
 *    requests all produced the same answer: nothing, reported as fine. Here
 *    every failure has an explicit availability and message.
 *  - **`--limit 30` was the whole corpus.** `gh pr list` has no offset, so this
 *    uses `gh api` with `per_page`/`page`, which does.
 *
 * Availability is probed before any listing, so "gh is not installed", "not a
 * GitHub remote", and "not authenticated" are distinguishable states rather
 * than one blank result.
 */
import type { ProjectGraphEdge, ProjectGraphNode } from '../../types';
import type { IndexPage, IndexSource, IndexSourceContext, SourcePrepareResult } from '../types';
import { provenanceFor } from '../../adapters/recordMapping';
import { shellQuote } from '../../adapters/fileEnumeration';

const PER_PAGE = 100;
const PR_PHASE = 'pr:';
const ISSUE_PHASE = 'issue:';

interface GhPull {
  number: number;
  title: string;
  state: string;
  user?: { login: string };
  created_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  user?: { login: string };
  labels?: Array<{ name: string } | string>;
  created_at?: string;
  closed_at?: string | null;
  /** Present only when the "issue" is really a pull request. */
  pull_request?: unknown;
}

export function createGitHubSource(): IndexSource {
  let repo = '';

  return {
    id: 'github',
    label: 'GitHub',

    async prepare(ctx): Promise<SourcePrepareResult> {
      const present = await ctx.host.exec('command -v gh', { timeout: 5000 });
      if (!present.success) {
        return { availability: 'unavailable', message: 'The gh CLI is not installed.', total: null };
      }
      const view = await ctx.host.exec('gh repo view --json nameWithOwner', { timeout: 15000 });
      if (!view.success) {
        const stderr = (view.stderr || '').trim();
        // `gh` reports auth and remote problems on stderr; passing the real text
        // through is the difference between a user fixing it and guessing.
        return {
          availability: /auth|token|login/i.test(stderr) ? 'unavailable' : 'error',
          message: stderr.slice(0, 200) || `gh repo view exited ${view.exitCode}`,
          total: null,
        };
      }
      try {
        repo = String((JSON.parse(view.stdout) as { nameWithOwner?: string }).nameWithOwner ?? '');
      } catch {
        return { availability: 'error', message: 'Could not parse gh repo view output.', total: null };
      }
      if (!repo) {
        return { availability: 'unavailable', message: 'No GitHub remote is configured.', total: null };
      }
      // The REST list endpoints do not report a total without walking every
      // page, so the denominator stays unknown rather than being guessed.
      return {
        availability: 'available',
        total: null,
        scope: `All pull requests and issues in ${repo}, paged through the REST API.`,
      };
    },

    async page(ctx, cursor): Promise<IndexPage> {
      const phase = cursor?.startsWith(ISSUE_PHASE) ? 'issues' : 'pulls';
      const pageNumber = Number(cursor?.slice(phase === 'issues' ? ISSUE_PHASE.length : PR_PHASE.length) || '1') || 1;
      const endpoint =
        phase === 'issues'
          ? `repos/${repo}/issues?state=all&per_page=${PER_PAGE}&page=${pageNumber}`
          : `repos/${repo}/pulls?state=all&per_page=${PER_PAGE}&page=${pageNumber}`;

      const res = await ctx.host.exec(`gh api ${shellQuote(endpoint)}`, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      ctx.signal.throwIfCancelled();
      if (!res.success) {
        throw new Error((res.stderr || `gh api exited ${res.exitCode}`).trim().slice(0, 200));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(res.stdout);
      } catch (err) {
        throw new Error(`Unparseable gh api response (${String(err).slice(0, 80)})`);
      }
      if (!Array.isArray(payload)) {
        throw new Error('gh api returned a non-list response.');
      }

      const records: ProjectGraphNode[] = [];
      const edges: ProjectGraphEdge[] = [];

      if (phase === 'pulls') {
        for (const pr of payload as GhPull[]) records.push(pullNode(pr));
      } else {
        for (const issue of payload as GhIssue[]) {
          // The issues endpoint returns pull requests too; they are already
          // indexed by the pulls phase, and counting them twice would inflate
          // every issue aggregate.
          if (issue.pull_request) continue;
          records.push(issueNode(issue));
        }
      }

      const exhausted = payload.length < PER_PAGE;
      const cursorNext =
        phase === 'pulls'
          ? exhausted
            ? `${ISSUE_PHASE}1`
            : `${PR_PHASE}${pageNumber + 1}`
          : exhausted
            ? undefined
            : `${ISSUE_PHASE}${pageNumber + 1}`;

      return { records, edges, cursor: cursorNext, rows: payload.length };
    },

    owns(nodeId) {
      return nodeId.startsWith('pr:') || nodeId.startsWith('issue:');
    },

    async resolve(ctx, nodeId) {
      if (!repo) return null;
      const isPr = nodeId.startsWith('pr:');
      const number = nodeId.slice(isPr ? 'pr:'.length : 'issue:'.length);
      const endpoint = `repos/${repo}/${isPr ? 'pulls' : 'issues'}/${number}`;
      const res = await ctx.host.exec(`gh api ${shellQuote(endpoint)}`, { timeout: 20000 });
      if (!res.success) return null;
      try {
        const parsed = JSON.parse(res.stdout);
        return isPr ? pullNode(parsed as GhPull) : issueNode(parsed as GhIssue);
      } catch {
        return null;
      }
    },
  };
}

function pullNode(pr: GhPull): ProjectGraphNode {
  const merged = pr.merged_at != null;
  return {
    id: `pr:${pr.number}`,
    type: 'github-pr',
    label: `#${pr.number}`,
    sublabel: pr.title,
    category: 'delivery',
    source: 'external',
    visibility: 'team-shared',
    status: merged ? 'merged' : pr.state.toLowerCase(),
    createdAt: parseIso(pr.created_at),
    // A pull request ends when it merges or when it closes unmerged; both are
    // times the service recorded, unlike the inferred dates elsewhere.
    closedAt: parseIso(pr.merged_at) ?? parseIso(pr.closed_at),
    fields: {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login,
      createdAt: pr.created_at ?? null,
      closedAt: pr.closed_at ?? null,
      mergedAt: pr.merged_at ?? null,
      state: pr.state,
      merged,
    },
  };
}

function issueNode(issue: GhIssue): ProjectGraphNode {
  const labels = (issue.labels ?? []).map(l => (typeof l === 'string' ? l : l.name));
  const isBug = labels.some(n => /bug|defect/i.test(n));
  return {
    id: `issue:${issue.number}`,
    type: isBug ? 'bug' : 'github-issue',
    label: `#${issue.number}`,
    sublabel: issue.title,
    category: 'delivery',
    source: 'external',
    visibility: 'team-shared',
    status: issue.state.toLowerCase(),
    severity: isBug ? inferSeverity(labels) : undefined,
    createdAt: parseIso(issue.created_at),
    closedAt: parseIso(issue.closed_at),
    fields: {
      number: issue.number,
      title: issue.title,
      labels,
      author: issue.user?.login,
      createdAt: issue.created_at ?? null,
      closedAt: issue.closed_at ?? null,
      state: issue.state,
    },
  };
}

/** Kept alongside the source so a caller can attach closing references later. */
export function closingReferenceEdge(prNumber: number, issueNumber: number): ProjectGraphEdge {
  return {
    id: `pr:${prNumber}->issue:${issueNumber}`,
    type: 'closes',
    sourceId: `pr:${prNumber}`,
    targetId: `issue:${issueNumber}`,
    provenance: provenanceFor('closes'),
  };
}

function inferSeverity(labels: string[]): ProjectGraphNode['severity'] {
  for (const l of labels) {
    if (/p0|critical/i.test(l)) return 'critical';
    if (/p1|high/i.test(l)) return 'high';
    if (/p2|medium/i.test(l)) return 'medium';
    if (/p3|low/i.test(l)) return 'low';
  }
  return undefined;
}

function parseIso(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export type { IndexSourceContext };
