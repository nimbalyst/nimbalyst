import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphNode } from '../types';
import { getFileDates } from './gitFileDates';

/**
 * Scans `docs/`, `design/`, and `nimbalyst-local/architecture/` for
 * markdown / architecture docs.
 *
 * Files under `nimbalyst-local/architecture/*.excalidraw` and
 * `design/**\/*-architecture*.md` are categorised as `architecture-doc`;
 * everything else is `markdown-doc`.
 */
const ROOTS = ['docs', 'design', 'nimbalyst-local/architecture'];
const MAX_PER_ROOT = 120;

export const docAdapter: Adapter = {
  id: 'docs',
  label: 'docs',
  async run(host): Promise<AdapterResult> {
    try {
      const lookups = ROOTS.map(root =>
        `[ -d ${root} ] && find ${root} -maxdepth 4 -type f \\( -name '*.md' -o -name '*.excalidraw' \\) 2>/dev/null | head -${MAX_PER_ROOT} || true`,
      );
      const found = await host.exec(lookups.join('; '), { timeout: 10000 });
      if (!found.success) {
        return { nodes: [], edges: [], status: 'error', message: found.stderr.slice(0, 200) };
      }
      const paths = Array.from(new Set(found.stdout.split('\n').map(s => s.trim()).filter(Boolean)));
      if (paths.length === 0) return { nodes: [], edges: [], status: 'ok' };

      const dates = await getFileDates(host, paths);

      const nodes: ProjectGraphNode[] = paths.map(path => {
        const base = path.split('/').pop() ?? path;
        const isArchitecture = path.includes('/architecture/')
          || /architecture/i.test(base)
          || path.endsWith('.excalidraw');
        return {
          id: `doc:${path}`,
          type: isArchitecture ? 'architecture-doc' : 'markdown-doc',
          label: base.replace(/\.(md|excalidraw)$/i, ''),
          sublabel: path,
          category: 'knowledge',
          source: 'file',
          visibility: 'workspace-shared',
          createdAt: dates.get(path),
          fields: { path },
        };
      });

      return { nodes, edges: [], status: 'ok' };
    } catch (err) {
      return { nodes: [], edges: [], status: 'error', message: String(err) };
    }
  },
};
