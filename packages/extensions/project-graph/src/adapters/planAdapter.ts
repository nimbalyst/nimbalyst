import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphNode } from '../types';
import { getFileDates } from './gitFileDates';
import { enumerateFiles, readFileHeads } from './fileEnumeration';

export const PLAN_ROOTS = ['nimbalyst-local/plans'];
/** Ceiling, not a page size — see {@link enumerateFiles}. */
const PLAN_SAFETY_MAX = 2000;

/**
 * Scans `nimbalyst-local/plans/*.md` for plan documents.
 *
 * Plans use YAML frontmatter under a `planStatus:` key. We extract the title,
 * status, and progress in a tolerant way (regex on the head of the file) so we
 * don't need a YAML parser.
 */
export const planAdapter: Adapter = {
  id: 'plans',
  label: 'plans',
  async run(host): Promise<AdapterResult> {
    try {
      const found = await enumerateFiles(host, {
        roots: PLAN_ROOTS,
        namePatterns: ['*.md'],
        maxDepth: 2,
        safetyMax: PLAN_SAFETY_MAX,
        timeoutMs: 8000,
      });
      const paths = found.paths;
      const notes = [...found.errors];
      if (found.truncationReason) notes.push(found.truncationReason);
      const message = notes.length > 0 ? notes.join('; ') : undefined;
      const status: AdapterResult['status'] = found.errors.length > 0 ? 'error' : 'ok';
      if (paths.length === 0) {
        return { nodes: [], edges: [], status, message };
      }

      const nodes: ProjectGraphNode[] = [];
      const dates = await getFileDates(host, paths);
      for (const { path, body } of await readFileHeads(host, paths)) {
        const title = matchFrontmatterField(body, 'title') ?? deriveTitleFromPath(path);
        const status = matchFrontmatterField(body, 'status');
        const progress = parseInt(matchFrontmatterField(body, 'progress') ?? '', 10);
        const tags = matchFrontmatterTags(body);

        nodes.push({
          id: `plan:${path}`,
          type: 'plan',
          label: title,
          sublabel: path,
          category: 'strategy',
          source: 'file',
          visibility: 'workspace-shared',
          status: status ?? undefined,
          progress: Number.isFinite(progress) ? progress : undefined,
          tags: tags.length > 0 ? tags : undefined,
          createdAt: dates.get(path),
          fields: { path },
        });
      }

      return { nodes, edges: [], status, message };
    } catch (err) {
      return { nodes: [], edges: [], status: 'error', message: String(err) };
    }
  },
};

function matchFrontmatterField(text: string, field: string): string | undefined {
  const re = new RegExp(`^\\s*${field}\\s*:\\s*['"]?(.+?)['"]?\\s*$`, 'm');
  const m = text.match(re);
  return m?.[1]?.trim();
}

/**
 * Parse a frontmatter `tags:` value in either form, tolerantly (no YAML parser):
 *   tags: [project-graph, ui]
 *   tags:
 *     - project-graph
 *     - ui
 * Stops the block-list scan at the first line that isn't an indented `- item`.
 */
function matchFrontmatterTags(text: string): string[] {
  const inline = text.match(/^\s*tags\s*:\s*\[(.*?)\]\s*$/m);
  if (inline) {
    return inline[1]!
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const lines = text.split('\n');
  const startIdx = lines.findIndex(l => /^\s*tags\s*:\s*$/.test(l));
  if (startIdx < 0) return [];
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*-\s*(.+?)\s*$/);
    if (!m) break;
    const v = m[1]!.replace(/^['"]|['"]$/g, '').trim();
    if (v) out.push(v);
  }
  return out;
}

function deriveTitleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '').replace(/[-_]/g, ' ');
}
