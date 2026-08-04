import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';

/**
 * Pulls recent PRs and issues from GitHub via the `gh` CLI.
 *
 * Adapter is best-effort: if `gh` isn't installed, the repo isn't a GitHub
 * repo, or the user isn't authenticated, we return `unavailable` and skip
 * silently. We never block the rest of the graph on GitHub.
 */
const MAX_PRS = 30;
const MAX_ISSUES = 30;

interface GhPr {
  number: number;
  title: string;
  state: string;
  author?: { login: string };
  url?: string;
  closingIssuesReferences?: Array<{ number: number }>;
  createdAt?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
}

interface GhIssue {
  number: number;
  title: string;
  state: string;
  author?: { login: string };
  labels?: Array<{ name: string }>;
  createdAt?: string;
  closedAt?: string | null;
}

function parseIso(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export const githubAdapter: Adapter = {
  id: 'github',
  label: 'github',
  async run(host): Promise<AdapterResult> {
    try {
      const ghCheck = await host.exec('command -v gh >/dev/null 2>&1 && echo yes || echo no', { timeout: 3000 });
      if (!/yes/.test(ghCheck.stdout)) {
        return { nodes: [], edges: [], status: 'unavailable', message: 'gh CLI not installed' };
      }

      const [prResult, issueResult] = await Promise.all([
        host.exec(
          `gh pr list --state all --limit ${MAX_PRS} --json number,title,state,author,closingIssuesReferences,createdAt,closedAt,mergedAt 2>/dev/null || true`,
          { timeout: 15000 },
        ),
        host.exec(
          `gh issue list --state all --limit ${MAX_ISSUES} --json number,title,state,author,labels,createdAt,closedAt 2>/dev/null || true`,
          { timeout: 15000 },
        ),
      ]);

      const nodes: ProjectGraphNode[] = [];
      const edges: ProjectGraphEdge[] = [];

      // PRs
      let prs: GhPr[] = [];
      try {
        prs = prResult.stdout.trim() ? (JSON.parse(prResult.stdout) as GhPr[]) : [];
      } catch {
        prs = [];
      }
      for (const pr of prs) {
        const id = `pr:${pr.number}`;
        // A PR's "end" is either when it merged or when it was closed without
        // merging. Either way it's terminal.
        const closedAt = parseIso(pr.mergedAt ?? null) ?? parseIso(pr.closedAt ?? null);
        nodes.push({
          id,
          type: 'github-pr',
          label: `#${pr.number}`,
          sublabel: pr.title,
          category: 'delivery',
          source: 'external',
          visibility: 'team-shared',
          status: pr.state.toLowerCase(),
          createdAt: parseIso(pr.createdAt),
          closedAt,
          fields: { number: pr.number, title: pr.title, author: pr.author?.login },
        });
        for (const ref of pr.closingIssuesReferences ?? []) {
          edges.push({ id: `${id}->issue:${ref.number}`, type: 'closes', sourceId: id, targetId: `issue:${ref.number}` });
        }
      }

      // Issues
      let issues: GhIssue[] = [];
      try {
        issues = issueResult.stdout.trim() ? (JSON.parse(issueResult.stdout) as GhIssue[]) : [];
      } catch {
        issues = [];
      }
      for (const issue of issues) {
        const labels = (issue.labels ?? []).map(l => l.name);
        const isBug = labels.some(n => /bug|defect/i.test(n));
        nodes.push({
          id: `issue:${issue.number}`,
          type: isBug ? 'bug' : 'github-issue',
          label: `#${issue.number}`,
          sublabel: issue.title,
          category: 'delivery',
          source: 'external',
          visibility: 'team-shared',
          status: issue.state.toLowerCase(),
          severity: isBug ? inferSeverity(labels) : undefined,
          createdAt: parseIso(issue.createdAt),
          closedAt: parseIso(issue.closedAt ?? null),
          fields: { number: issue.number, title: issue.title, labels, author: issue.author?.login },
        });
      }

      return { nodes, edges, status: 'ok' };
    } catch (err) {
      return { nodes: [], edges: [], status: 'error', message: String(err) };
    }
  },
};

function inferSeverity(labels: string[]): ProjectGraphNode['severity'] {
  for (const l of labels) {
    if (/p0|critical/i.test(l)) return 'critical';
    if (/p1|high/i.test(l)) return 'high';
    if (/p2|medium/i.test(l)) return 'medium';
    if (/p3|low/i.test(l)) return 'low';
  }
  return undefined;
}
