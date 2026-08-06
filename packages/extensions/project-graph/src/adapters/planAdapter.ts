import type { Adapter, AdapterResult } from './types';
import type { ProjectGraphNode } from '../types';
import { getFileDates } from './gitFileDates';

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
      const list = await host.exec(
        `[ -d nimbalyst-local/plans ] && find nimbalyst-local/plans -maxdepth 2 -type f -name '*.md' 2>/dev/null | head -200 || true`,
        { timeout: 8000 },
      );
      const paths = list.stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (paths.length === 0) {
        return { nodes: [], edges: [], status: 'ok' };
      }

      // Read frontmatter headers in one batched call. `head -c 4000` keeps each
      // read bounded so a huge plan doesn't blow our buffer.
      const heads = await host.exec(
        paths.map(p => `echo "__PG_PLAN__:${p}"; head -c 4000 "${p}"`).join('; '),
        { timeout: 15000 },
      );
      if (!heads.success) {
        return { nodes: [], edges: [], status: 'error', message: heads.stderr.slice(0, 200) };
      }

      const nodes: ProjectGraphNode[] = [];
      const dates = await getFileDates(host, paths);
      const blocks = heads.stdout.split('__PG_PLAN__:').filter(Boolean);
      for (const block of blocks) {
        const nl = block.indexOf('\n');
        const path = (nl >= 0 ? block.slice(0, nl) : block).trim();
        const body = nl >= 0 ? block.slice(nl + 1) : '';
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

      return { nodes, edges: [], status: 'ok' };
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
