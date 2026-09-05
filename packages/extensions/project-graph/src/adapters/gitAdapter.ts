import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';
import { dirLabel, dirNodeId, moduleForPath } from './paths';
import { provenanceFor } from './recordMapping';

/**
 * Pulls recent commits and the files they touched out of git.
 *
 * Emits:
 *   - commit nodes (last N commits)
 *   - directory nodes (rolled up from touched files via {@link moduleForPath})
 *   - commit `touches` directory edges (deduped so one edge per commit+dir)
 */
const MAX_COMMITS = 500;

export const gitAdapter: Adapter = {
  id: 'git',
  label: 'git',
  async run(host): Promise<AdapterResult> {
    try {
      // Bail early if not in a git repo.
      const check = await host.exec('git rev-parse --is-inside-work-tree 2>/dev/null || true', { timeout: 5000 });
      if (!check.success || !/true/.test(check.stdout)) {
        return { nodes: [], edges: [], status: 'unavailable', message: 'not a git repo' };
      }

      // commitHash<RS>subject<RS>author<RS>iso-date<US> per commit
      const FORMAT = '%H%x1F%s%x1F%an%x1F%aI';
      const log = await host.exec(
        `git log -n ${MAX_COMMITS} --name-only --no-merges --pretty=format:'__COMMIT__${FORMAT}'`,
        { timeout: 30000, maxBuffer: 50 * 1024 * 1024 },
      );
      if (!log.success) {
        return { nodes: [], edges: [], status: 'error', message: log.stderr.slice(0, 200) };
      }

      const nodes: ProjectGraphNode[] = [];
      const edges: ProjectGraphEdge[] = [];
      const dirNodes = new Map<string, { count: number }>();
      const seenEdgeIds = new Set<string>();

      // Split into per-commit blocks. The very first line starts with __COMMIT__.
      const blocks = log.stdout.split('__COMMIT__').filter(Boolean);
      for (const block of blocks) {
        const lines = block.split('\n');
        const header = lines[0] ?? '';
        const [hash, subject, author, isoDate] = header.split('\x1F');
        if (!hash) continue;
        const shortHash = hash.slice(0, 7);
        const commitId = `commit:${hash}`;
        const createdAt = isoDate ? Date.parse(isoDate) : NaN;
        nodes.push({
          id: commitId,
          type: 'commit',
          label: shortHash,
          sublabel: subject?.slice(0, 60),
          category: 'delivery',
          source: 'git',
          visibility: 'workspace-shared',
          createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
          fields: { hash, subject, author, isoDate, path: hash },
        });

        const files = lines.slice(1).map(s => s.trim()).filter(Boolean);
        const dirsTouchedByCommit = new Set<string>();
        for (const file of files) {
          const dir = moduleForPath(file, host.workspacePath);
          if (!dir) continue;
          const existing = dirNodes.get(dir);
          dirNodes.set(dir, { count: (existing?.count ?? 0) + 1 });
          dirsTouchedByCommit.add(dir);
        }
        for (const dir of dirsTouchedByCommit) {
          const dirId = dirNodeId(dir);
          const edgeId = `${commitId}->${dirId}`;
          if (seenEdgeIds.has(edgeId)) continue;
          seenEdgeIds.add(edgeId);
          edges.push({
            id: edgeId,
            type: 'touches',
            sourceId: commitId,
            targetId: dirId,
            provenance: provenanceFor('touches'),
          });
        }
      }

      // Emit one node per directory we saw. Sort by touch count so the layout's
      // alphabetical sort doesn't bury the hottest dirs.
      for (const [dir, info] of dirNodes) {
        nodes.push({
          id: dirNodeId(dir),
          type: 'directory',
          label: dirLabel(dir),
          sublabel: dir,
          category: 'knowledge',
          source: 'file',
          visibility: 'workspace-shared',
          badges: [{ key: 'touches', value: info.count }],
          fields: { path: dir, rollup: true, touchCount: info.count },
        });
      }

      return { nodes, edges, status: 'ok' };
    } catch (err) {
      return { nodes: [], edges: [], status: 'error', message: String(err) };
    }
  },
};
