import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphNode } from '../types';
import { getFileDates } from './gitFileDates';
import { enumerateFiles } from './fileEnumeration';

/**
 * Scans `docs/`, `design/`, and `nimbalyst-local/architecture/` for
 * markdown / architecture docs.
 *
 * Files under `nimbalyst-local/architecture/*.excalidraw` and
 * `design/**\/*-architecture*.md` are categorised as `architecture-doc`;
 * everything else is `markdown-doc`.
 */
export const DOC_ROOTS = ['docs', 'design', 'nimbalyst-local/architecture'];
/**
 * A ceiling, not a page size: enumeration is complete below it and reports
 * itself truncated above it. The old `head -120` per root silently dropped
 * files and never said so.
 */
const DOC_SAFETY_MAX = 5000;

export const docAdapter: Adapter = {
  id: 'docs',
  label: 'docs',
  async run(host): Promise<AdapterResult> {
    try {
      const found = await enumerateFiles(host, {
        roots: DOC_ROOTS,
        namePatterns: ['*.md', '*.excalidraw'],
        maxDepth: 4,
        safetyMax: DOC_SAFETY_MAX,
        timeoutMs: 10000,
      });
      const paths = found.paths;
      const notes = [...found.errors];
      if (found.truncationReason) notes.push(found.truncationReason);
      if (paths.length === 0) {
        return {
          nodes: [],
          edges: [],
          status: found.errors.length > 0 ? 'error' : 'ok',
          message: notes.length > 0 ? notes.join('; ') : undefined,
        };
      }

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

      return {
        nodes,
        edges: [],
        status: found.errors.length > 0 ? 'error' : 'ok',
        message: notes.length > 0 ? notes.join('; ') : undefined,
      };
    } catch (err) {
      return { nodes: [], edges: [], status: 'error', message: String(err) };
    }
  },
};
