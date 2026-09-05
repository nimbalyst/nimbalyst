/**
 * Filesystem-backed sources: plans, documents, and memory facts.
 *
 * All three share one shape — enumerate completely, then read bounded heads in
 * pages — so they share one implementation. The enumeration happens once during
 * `prepare`, which is also what makes `total` authoritative here: the file list
 * is known before any head is read, so coverage can state "N of M" honestly
 * from the first page.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { ProjectGraphNode } from '../../types';
import type { IndexPage, IndexSource, SourcePrepareResult } from '../types';
import { enumerateFiles, readFileHeads } from '../../adapters/fileEnumeration';
import { getFileDates } from '../../adapters/gitFileDates';

interface FileSourceSpec {
  id: 'plans' | 'docs' | 'memory';
  label: string;
  roots: readonly string[];
  namePatterns: readonly string[];
  maxDepth: number;
  idPrefix: string;
  /** Plural noun for the scope line shown next to the counts. */
  scopeNoun: string;
  /** Message used when none of the roots exist. */
  absentMessage: string;
  /** Extra note always appended to coverage, e.g. a source's known limits. */
  note?: string;
  /**
   * Appended to the SCOPE line. Belongs here rather than in `note` when it
   * narrows what the source claims to cover, since scope is what a reader
   * checks before trusting a count.
   */
  scopeSuffix?: string;
  toNode(input: { path: string; body: string; createdAt: number | undefined }): ProjectGraphNode;
}

function createFileSource(spec: FileSourceSpec): IndexSource {
  let paths: string[] = [];
  let dates = new Map<string, number>();

  return {
    id: spec.id,
    label: spec.label,

    async prepare(ctx): Promise<SourcePrepareResult> {
      const found = await enumerateFiles(ctx.host, {
        roots: spec.roots,
        namePatterns: spec.namePatterns,
        maxDepth: spec.maxDepth,
        // No fallback ceiling. The old `?? 5000` was a limit nobody set and
        // nobody could see, and because the truncation never reached coverage
        // the capped answer also reported itself complete.
        safetyMax: ctx.options.safetyMax[spec.id],
      });
      paths = found.paths;
      dates = new Map();
      const scope = [
        `${spec.scopeNoun} under ${spec.roots.join(', ')} (depth ${spec.maxDepth}).`,
        spec.scopeSuffix,
      ]
        .filter(Boolean)
        .join(' ');

      if (found.errors.length > 0) {
        return { availability: 'error', message: found.errors.join('; '), total: found.found, scope };
      }
      if (paths.length === 0) {
        // An absent directory is a real answer about this workspace, not a
        // failure — but it must be stated, not rendered as an empty success.
        return { availability: 'unavailable', message: spec.absentMessage, total: 0, scope };
      }
      const notes = [spec.note, found.truncationReason].filter(Boolean);
      return {
        availability: 'available',
        message: notes.length > 0 ? notes.join(' ') : undefined,
        total: found.found,
        scope,
        // Enumeration truncates BEFORE any page runs, so it has to be reported
        // from here or the coverage never sees it.
        truncated: found.truncated,
        truncationReason: found.truncationReason,
      };
    },

    async page(ctx, cursor, pageSize): Promise<IndexPage> {
      const start = cursor ? Number(cursor) : 0;
      const batch = paths.slice(start, start + pageSize);
      if (batch.length === 0) return { records: [], edges: [], rows: 0 };

      if (dates.size === 0) dates = await getFileDates(ctx.host, paths);
      const heads = await readFileHeads(ctx.host, batch);
      ctx.signal.throwIfCancelled();

      const records = heads.map(({ path, body }) =>
        spec.toNode({ path, body, createdAt: dates.get(path) }),
      );
      const next = start + batch.length;
      return {
        records,
        edges: [],
        cursor: next < paths.length ? String(next) : undefined,
        rows: batch.length,
      };
    },

    owns(nodeId) {
      return nodeId.startsWith(spec.idPrefix);
    },

    async resolve(ctx, nodeId) {
      const path = nodeId.slice(spec.idPrefix.length);
      const [head] = await readFileHeads(ctx.host, [path]);
      if (!head) return null;
      const fileDates = await getFileDates(ctx.host, [path]);
      return spec.toNode({ path, body: head.body, createdAt: fileDates.get(path) });
    },

    async loadDetail(ctx, nodeId) {
      const path = nodeId.slice(spec.idPrefix.length);
      // A larger read than the indexing pass, which only wants frontmatter,
      // but still bounded: the index must never pull a whole document tree
      // into memory because someone clicked one node.
      const [head] = await readFileHeads(ctx.host, [path], { bytes: DETAIL_BYTES });
      if (!head) return null;
      return {
        body: head.body,
        truncated: head.body.length >= DETAIL_BYTES,
        fields: { detailBytes: DETAIL_BYTES },
      };
    },
  };
}

/** Ceiling on a single on-demand body read. */
const DETAIL_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Frontmatter parsing (tolerant; no YAML dependency)
// ---------------------------------------------------------------------------

/**
 * The LEADING frontmatter block, or `''` when the file has none.
 *
 * Frontmatter is only frontmatter at the very start of the file. Scanning the
 * whole 4 KB head instead turned two real things in this workspace into plan
 * fields: a TypeScript declaration inside a fenced code block
 * (`status: TrackerItemStatus;  // Current status`) and a `---` thematic break
 * after a heading. Both surfaced in the live view as plans with invented
 * statuses.
 */
export function leadingFrontmatter(text: string): string {
  // `---` must be the first thing in the file, and the block must close.
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? '';
}

/**
 * Read a field from a frontmatter block. Matches at the top level or nested one
 * level under a parent key (plans put everything under `planStatus:`), which is
 * as much YAML as this needs to understand.
 */
export function matchFrontmatterField(text: string, field: string): string | undefined {
  const re = new RegExp(`^\\s*${field}\\s*:\\s*['"]?(.+?)['"]?\\s*$`, 'm');
  const value = text.match(re)?.[1]?.trim();
  // A value that is only a comment, or empty, is not a value.
  if (!value || value.startsWith('#')) return undefined;
  return value;
}

/**
 * Parse a frontmatter `tags:` value in either the inline or block form. Stops
 * the block scan at the first line that is not an indented `- item`.
 */
export function matchFrontmatterTags(text: string): string[] {
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
  return base.replace(/\.(md|excalidraw)$/i, '').replace(/[-_]/g, ' ');
}

/**
 * Directories that are gitignored, so nothing under them is shared with anyone.
 * `nimbalyst-local/` is ignored at `.gitignore:168`.
 */
const LOCAL_ONLY_ROOTS = ['nimbalyst-local'] as const;

/**
 * Visibility for a file, decided by WHERE IT LIVES rather than by which source
 * found it.
 *
 * A per-source constant cannot be right: the docs source spans both `docs/`
 * (tracked, shared with everyone who clones) and `nimbalyst-local/architecture`
 * (gitignored, on this machine only). Reporting the latter as
 * workspace-shared overstates who can see it.
 */
export function visibilityForPath(path: string): ProjectGraphNode['visibility'] {
  const local = LOCAL_ONLY_ROOTS.some(root => path === root || path.startsWith(`${root}/`));
  return local ? 'local' : 'workspace-shared';
}

// ---------------------------------------------------------------------------
// Concrete sources
// ---------------------------------------------------------------------------

export function createPlansSource(roots: readonly string[] = ['nimbalyst-local/plans']): IndexSource {
  return createFileSource({
    id: 'plans',
    label: 'Plan documents',
    roots,
    namePatterns: ['*.md'],
    maxDepth: 2,
    idPrefix: 'plan:',
    scopeNoun: 'Plan documents',
    absentMessage: `No plan documents found under ${roots.join(', ')}.`,
    toNode({ path, body, createdAt }) {
      // ONLY the leading block. Scanning the whole head made a fenced TypeScript
      // declaration and a post-heading `---` into plan statuses; see
      // `leadingFrontmatter`.
      const front = leadingFrontmatter(body);
      const progress = parseInt(matchFrontmatterField(front, 'progress') ?? '', 10);
      const tags = matchFrontmatterTags(front);
      return {
        id: `plan:${path}`,
        type: 'plan',
        label: matchFrontmatterField(front, 'title') ?? deriveTitleFromPath(path),
        sublabel: path,
        category: 'strategy',
        source: 'file',
        visibility: visibilityForPath(path),
        status: matchFrontmatterField(front, 'status') ?? undefined,
        progress: Number.isFinite(progress) ? progress : undefined,
        tags: tags.length > 0 ? tags : undefined,
        createdAt,
        fields: { path },
      };
    },
  });
}

export function createDocsSource(
  roots: readonly string[] = ['docs', 'design', 'nimbalyst-local/architecture'],
): IndexSource {
  return createFileSource({
    id: 'docs',
    label: 'Documents',
    roots,
    namePatterns: ['*.md', '*.excalidraw'],
    maxDepth: 4,
    idPrefix: 'doc:',
    scopeNoun: 'Markdown and Excalidraw documents',
    absentMessage: `No documents found under ${roots.join(', ')}.`,
    toNode({ path, createdAt }) {
      const base = path.split('/').pop() ?? path;
      const isArchitecture =
        path.includes('/architecture/') || /architecture/i.test(base) || path.endsWith('.excalidraw');
      return {
        id: `doc:${path}`,
        type: isArchitecture ? 'architecture-doc' : 'markdown-doc',
        label: base.replace(/\.(md|excalidraw)$/i, ''),
        sublabel: path,
        category: 'knowledge',
        source: 'file',
        // Per PATH, not per source: this source spans both tracked roots and
        // the gitignored `nimbalyst-local/architecture`.
        visibility: visibilityForPath(path),
        createdAt,
        fields: { path },
      };
    },
  });
}

/**
 * Memory facts, read from the store the memory extension actually writes.
 *
 * `FactsStore` keeps facts as markdown files with `category`, `scope`,
 * `priority` and `created` frontmatter under the engine's facts directory
 * (`nimbalyst-local/voice-memory` as the memory extension configures it). Those
 * four fields plus the fact text are the entirety of what a fact records.
 *
 * In particular a fact records NO citations and NO links to the sessions,
 * trackers or documents it came from. So this source emits no edges, and its
 * coverage says so — inventing a "derived from" relationship would be
 * fabricating exactly the provenance the redesign exists to protect.
 */
export function createMemorySource(roots: readonly string[] = ['nimbalyst-local/voice-memory']): IndexSource {
  return createFileSource({
    id: 'memory',
    label: 'Memory facts',
    roots,
    namePatterns: ['*.md'],
    maxDepth: 3,
    idPrefix: 'memory:',
    scopeNoun: 'Memory fact files',
    // The memory engine resolves more roots than this: one is flagged
    // `personal` and lives outside the workspace (see the engine's roots.ts).
    // A user reading "memory: 2 records" must not conclude their memory is
    // nearly empty, so the narrowing is stated in the scope, not buried.
    scopeSuffix:
      'This is the workspace facts directory only; the memory engine also resolves a personal root outside the workspace, which is not indexed here.',
    absentMessage: `No memory facts are stored in this workspace (${roots.join(', ')} is absent or empty).`,
    note:
      'Fact files record category, scope, priority and creation time. They record no citations, so no relationships are available from this source. ' +
      'This reads the workspace facts directory only; the memory engine also indexes a personal root outside the workspace, which is not indexed here.',
    toNode({ path, body, createdAt }) {
      const { frontmatter, text } = splitFrontmatter(body);
      const created = matchFrontmatterField(frontmatter, 'created');
      const createdMs = created ? Date.parse(created) : NaN;
      const category = matchFrontmatterField(frontmatter, 'category');
      const scope = matchFrontmatterField(frontmatter, 'scope');
      const priority = parseInt(matchFrontmatterField(frontmatter, 'priority') ?? '', 10);
      const label = text.trim().split('\n')[0]?.slice(0, 120) || (path.split('/').pop() ?? path);
      return {
        id: `memory:${path}`,
        type: 'memory-fact',
        label,
        sublabel: scope ?? category ?? undefined,
        category: 'memory',
        source: 'memory',
        visibility: 'local',
        tags: category ? [category] : undefined,
        // The `created` frontmatter is written by `remember` at write time, so
        // it is a recorded time. The file date is only a fallback.
        createdAt: Number.isFinite(createdMs) ? createdMs : createdAt,
        fields: {
          path,
          factCategory: category ?? null,
          scope: scope ?? null,
          priority: Number.isFinite(priority) ? priority : 0,
          createdAt: created ?? null,
          // Stated explicitly so a consumer cannot read "no edges" as "checked
          // and found none".
          citations: null,
          citationsAvailable: false,
        },
      };
    },
  });
}

function splitFrontmatter(body: string): { frontmatter: string; text: string } {
  const match = body.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: '', text: body };
  return { frontmatter: match[1] ?? '', text: body.slice(match[0].length) };
}

/** Exported for the index's source registry. */
export type { PanelHost };
