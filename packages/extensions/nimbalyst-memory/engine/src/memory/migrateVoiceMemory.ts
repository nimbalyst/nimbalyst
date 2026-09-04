/**
 * Migration of the v1 ADD-only markdown facts under `voice-memory/` into fact
 * model v3.
 *
 * **This reads and never writes.** It does not move, rename, truncate, or
 * delete a single source file, and it returns records for the caller to
 * persist rather than persisting them itself. A migration that reads from one
 * place and writes to another is recoverable by construction; one that moves is
 * not, and this repo has a standing rule against destroying user data on a
 * heuristic. The source markdown stays exactly where it is, and the caller
 * decides — later, and separately — whether it is ever removed.
 *
 * Every fact passes through the same {@link writeMemoryPage} gates as a fresh
 * page. That is the point of the exercise rather than an implementation detail:
 * v1 facts are one-liners, so the shape gate rejects them, and a migration that
 * quietly waived it would import exactly the shape decision 7 exists to
 * eliminate. A rejected fact is reported with its full text and the reason, so
 * it can be expanded into a page by hand or by phase 8's distiller; nothing is
 * lost, because the file it came from is still there.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { parseFrontmatter } from '../frontmatter.js';
import type { DedupIndex } from '../dedup/index.js';
import { writeMemoryPage, type MemoryWriteOutcome } from './write.js';
import type { MemoryRecord, MemoryScope, MemoryType } from './types.js';

export interface VoiceMemoryMigrationOptions {
  /** Scope for migrated pages. Personal by default: v1 facts were never
   * reviewed for sharing and nobody consented to publishing them. */
  scope?: MemoryScope;
  /** Dedup index of already-migrated pages, so a re-run is idempotent. */
  dedup?: DedupIndex;
}

/** A source fact that did not become a record, with enough detail to act on. */
export interface SkippedVoiceMemory {
  sourcePath: string;
  text: string;
  reason: 'page-too-thin' | 'blocked-by-redaction' | 'duplicate' | 'unreadable';
  detail: string;
}

export interface VoiceMemoryMigration {
  /** Records to persist. The caller writes them; this function does not. */
  records: MemoryRecord[];
  skipped: SkippedVoiceMemory[];
  /** Source files read. Every one of them still exists afterwards. */
  scanned: number;
}

/**
 * v1 facts carried a free-form `category`. Map the ones that correspond to a
 * v3 facet and fall back to `fact`, which is the honest answer for a note
 * nobody typed a facet for.
 */
function toMemoryType(category: unknown): MemoryType {
  const raw = typeof category === 'string' ? category.trim().toLowerCase() : '';
  switch (raw) {
    case 'decision':
    case 'preference':
    case 'instruction':
    case 'convention':
    case 'constraint':
    case 'error':
    case 'fact':
      return raw;
    case 'rule':
    case 'guideline':
      return 'convention';
    case 'mistake':
    case 'failure':
      return 'error';
    default:
      return 'fact';
  }
}

function describe(outcome: MemoryWriteOutcome): SkippedVoiceMemory['reason'] | null {
  switch (outcome.status) {
    case 'rejected':
      return 'page-too-thin';
    case 'blocked':
      return 'blocked-by-redaction';
    case 'discarded':
      return 'duplicate';
    default:
      return null;
  }
}

/**
 * Read every fact under `factsDir` and project it into fact model v3.
 *
 * @param root engine root
 * @param factsDir directory of v1 markdown facts, relative to `root`
 */
export async function migrateVoiceMemory(
  root: string,
  factsDir: string,
  options: VoiceMemoryMigrationOptions = {}
): Promise<VoiceMemoryMigration> {
  const dir = path.join(root, factsDir);
  const files = await fg('**/*.md', {
    cwd: dir,
    absolute: true,
    dot: true,
    onlyFiles: true,
    suppressErrors: true,
  });
  files.sort();

  const records: MemoryRecord[] = [];
  const skipped: SkippedVoiceMemory[] = [];

  for (const abs of files) {
    const sourcePath = path.relative(root, abs).split(path.sep).join('/');
    let body = '';
    let created: string | undefined;
    let type: MemoryType = 'fact';
    try {
      const raw = await readFile(abs, 'utf8');
      const { data, body: parsed } = parseFrontmatter(raw);
      body = parsed.trim();
      type = toMemoryType(data.category);
      // `created` in frontmatter is the honest `validFrom`: it is when the
      // claim was made. Fall back to mtime only when it is missing.
      created =
        typeof data.created === 'string' && Number.isFinite(Date.parse(data.created))
          ? new Date(data.created).toISOString()
          : new Date((await stat(abs)).mtimeMs).toISOString();
    } catch (err) {
      skipped.push({
        sourcePath,
        text: '',
        reason: 'unreadable',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!body) continue;

    const outcome = writeMemoryPage(
      {
        body,
        type,
        scope: options.scope ?? 'personal',
        provenance: { kind: 'imported', sourcePath },
        validFrom: created,
        now: created ? new Date(created) : undefined,
      },
      { dedup: options.dedup }
    );

    const reason = describe(outcome);
    if (reason) {
      skipped.push({ sourcePath, text: body, reason, detail: explain(outcome) });
      continue;
    }
    if (outcome.status === 'stored' || outcome.status === 'review') {
      records.push(outcome.record);
      options.dedup?.add(outcome.record.factId, outcome.record.body);
    }
  }

  return { records, skipped, scanned: files.length };
}

function explain(outcome: MemoryWriteOutcome): string {
  switch (outcome.status) {
    case 'rejected':
      return `not a page (${outcome.problems.join(', ')}); expand it with its surrounding context to import it`;
    case 'blocked':
      return outcome.blocks.map((b) => b.reason).join('; ');
    case 'discarded':
      return `already imported as ${outcome.duplicateOf}`;
    default:
      return '';
  }
}
