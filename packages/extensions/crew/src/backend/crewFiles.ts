/**
 * Crew file IO: definition files, and each member's journal and notes.
 *
 * These files are the member's memory and exist in exactly one place, so the
 * write rules are strict:
 * - The journal and handoff summaries are appended (O_APPEND), never rewritten.
 * - A rewrite (definition update, notes replace) re-reads the file right
 *   before replacing it and gives up if it changed since the caller read it
 *   (for notes, since the member or the desk loaded them), so a concurrent
 *   edit is never overwritten. The replace itself
 *   is a temp file + rename, so a crash leaves the old or the new file, never
 *   half of one.
 * - Replacing notes first keeps the previous content in `notes.previous.md`.
 * - A file that fails to parse is reported, never truncated or "repaired".
 * - Deleting a member moves its files under `crew/.deleted/`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CrewMemberDefinition, CrewMemberDraft } from '../shared/types';
import {
  CREW_DIR,
  assertSlug,
  brokenMemberDefinition,
  crewDefinitionPath,
  crewDir,
  crewMemoryDir,
  isValidCrewSlug,
  parseCrewMemberFile,
  serializeCrewMember,
  splitCrewFile,
} from './crewDefinition';

export interface LoadedCrewMember {
  slug: string;
  definition: CrewMemberDefinition;
  /** Human-readable validation errors; non-empty means the member cannot run. */
  errors: string[];
}

const MAX_CAS_ATTEMPTS = 3;

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Serializes read-compare-write sequences on one file. The host runs one
 * backend process per workspace, so an in-process lock is enough to make
 * `replaceIfUnchanged` atomic against this module's own writers; edits from
 * outside the process (the user's editor) are still caught by the compare.
 */
const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  fileLocks.set(filePath, next);
  try {
    return await next;
  } finally {
    if (fileLocks.get(filePath) === next) fileLocks.delete(filePath);
  }
}

/**
 * Refuses a path that resolves outside `<workspace>/nimbalyst-local/crew`,
 * for example through a symlinked member folder or definition file. Resolves
 * the deepest part of the path that exists (the target itself when present, so
 * a symlinked file is followed) and checks the result stays under the crew
 * folder. This is containment for Crew's own file IO, not a permission layer.
 */
export async function assertInCrewDir(workspacePath: string, target: string): Promise<void> {
  const root = path.join(await fs.realpath(workspacePath), CREW_DIR);
  const missing: string[] = [];
  let existing = path.resolve(target);
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(existing, ...missing);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${path.basename(target)} resolves outside ${CREW_DIR}; crew files and folders may not link out of the crew folder`);
  }
}

/** Replaces `filePath` only if it still holds `expected`. Returns false if it changed underneath. */
async function replaceIfUnchanged(filePath: string, expected: string | null, next: string): Promise<boolean> {
  const current = await readTextIfExists(filePath);
  if (current !== expected) return false;
  await writeFileAtomic(filePath, next);
  return true;
}

export class CrewFileConflictError extends Error {
  constructor(filePath: string) {
    super(`${path.basename(filePath)} changed while it was being updated; reload and try again`);
    this.name = 'CrewFileConflictError';
  }
}

// ─── Definitions ──────────────────────────────────────────────────────────

function loadFromText(slug: string, sourcePath: string, text: string): LoadedCrewMember {
  const result = parseCrewMemberFile(slug, sourcePath, text);
  if (result.ok) return { slug, definition: result.definition, errors: [] };
  return {
    slug,
    definition: brokenMemberDefinition(slug, sourcePath),
    errors: result.errors.map((error) => `${error.path} ${error.message}`),
  };
}

/** Every `*.md` in the crew directory. A malformed file becomes a member with errors; nothing throws for one bad file. */
export async function loadCrewMembers(workspacePath: string): Promise<LoadedCrewMember[]> {
  let entries: string[];
  try {
    await assertInCrewDir(workspacePath, crewDir(workspacePath));
    entries = await fs.readdir(crewDir(workspacePath));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const members: LoadedCrewMember[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md') || entry.startsWith('.') || entry.startsWith('_')) continue;
    const slug = entry.slice(0, -3);
    const sourcePath = path.join(crewDir(workspacePath), entry);
    try {
      await assertInCrewDir(workspacePath, sourcePath);
      const text = await fs.readFile(sourcePath, 'utf8');
      members.push(loadFromText(slug, sourcePath, text));
    } catch (error) {
      if (isErrno(error, 'EISDIR')) continue;
      members.push({
        slug,
        definition: brokenMemberDefinition(slug, sourcePath),
        errors: [`file could not be read: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }
  return members;
}

export async function loadCrewMember(workspacePath: string, slug: string): Promise<LoadedCrewMember | null> {
  if (!isValidCrewSlug(slug)) return null;
  const sourcePath = crewDefinitionPath(workspacePath, slug);
  try {
    await assertInCrewDir(workspacePath, sourcePath);
  } catch (error) {
    return { slug, definition: brokenMemberDefinition(slug, sourcePath), errors: [error instanceof Error ? error.message : String(error)] };
  }
  const text = await readTextIfExists(sourcePath);
  return text === null ? null : loadFromText(slug, sourcePath, text);
}

/** Creates the definition and empty memory files. Refuses to replace an existing member. */
export async function createCrewMemberFiles(workspacePath: string, draft: CrewMemberDraft): Promise<void> {
  assertSlug(draft.slug);
  await assertInCrewDir(workspacePath, crewDefinitionPath(workspacePath, draft.slug));
  await fs.mkdir(crewDir(workspacePath), { recursive: true });
  try {
    await fs.writeFile(crewDefinitionPath(workspacePath, draft.slug), serializeCrewMember(draft), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (isErrno(error, 'EEXIST')) throw new Error(`A crew member named "${draft.slug}" already exists`);
    throw error;
  }
  await ensureMemoryFiles(workspacePath, draft.slug);
}

/**
 * Read-modify-write of a definition file. Refuses to touch a file whose YAML
 * does not parse or whose definition does not validate: the user is mid-edit
 * and their text wins.
 */
export async function updateCrewMemberFile(
  workspacePath: string,
  slug: string,
  mutate: (current: CrewMemberDefinition) => CrewMemberDraft,
): Promise<void> {
  const filePath = crewDefinitionPath(workspacePath, slug);
  await assertInCrewDir(workspacePath, filePath);
  return withFileLock(filePath, () => updateUnlocked(filePath, slug, mutate));
}

async function updateUnlocked(
  filePath: string,
  slug: string,
  mutate: (current: CrewMemberDefinition) => CrewMemberDraft,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const text = await readTextIfExists(filePath);
    if (text === null) throw new Error(`Crew member "${slug}" not found`);
    const loaded = loadFromText(slug, filePath, text);
    if (loaded.errors.length > 0) {
      throw new Error(`${slug}.md has errors; fix the file before changing it here: ${loaded.errors.join('; ')}`);
    }
    const rawCrew = (splitCrewFile(text).frontmatter as { crew?: unknown } | undefined)?.crew;
    const next = serializeCrewMember(mutate(loaded.definition), rawCrew);
    if (next === text) return;
    if (await replaceIfUnchanged(filePath, text, next)) return;
  }
  throw new CrewFileConflictError(filePath);
}

/** Moves the definition and memory directory under `crew/.deleted/`, never unlinks them. */
export async function archiveCrewMemberFiles(workspacePath: string, slug: string, nowMs: number): Promise<string> {
  assertSlug(slug);
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const target = path.join(crewDir(workspacePath), '.deleted', `${slug}-${stamp}`);
  await assertInCrewDir(workspacePath, target);
  await fs.mkdir(target, { recursive: true });
  for (const source of [crewDefinitionPath(workspacePath, slug), crewMemoryDir(workspacePath, slug)]) {
    // A rename moves the link itself, not what it points at, so only the parent matters here.
    await assertInCrewDir(workspacePath, path.dirname(source));
    try {
      await fs.rename(source, path.join(target, path.basename(source)));
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
  return target;
}

// ─── Journal and notes ────────────────────────────────────────────────────

export function journalPath(workspacePath: string, slug: string): string {
  return path.join(crewMemoryDir(workspacePath, slug), 'journal.md');
}

export function notesPath(workspacePath: string, slug: string): string {
  return path.join(crewMemoryDir(workspacePath, slug), 'notes.md');
}

export async function ensureMemoryFiles(workspacePath: string, slug: string): Promise<void> {
  await assertInCrewDir(workspacePath, crewMemoryDir(workspacePath, slug));
  await fs.mkdir(crewMemoryDir(workspacePath, slug), { recursive: true });
  const seeds: Array<[string, string]> = [
    [notesPath(workspacePath, slug), '# Notes\n\nStanding concerns, open threads, and what I have learned about how you want me to work. Edit freely; I read this at the start of every chapter.\n'],
    [journalPath(workspacePath, slug), '# Journal\n'],
  ];
  for (const [filePath, seed] of seeds) {
    try {
      await fs.writeFile(filePath, seed, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
  }
}

/** Size and modification time of a member's notes and journal, for change detection. */
export async function memoryFileStamps(workspacePath: string, slug: string): Promise<Array<[number, number] | null>> {
  return Promise.all([notesPath(workspacePath, slug), journalPath(workspacePath, slug)].map(async (filePath) => {
    try {
      await assertInCrewDir(workspacePath, filePath);
      const stat = await fs.stat(filePath);
      return [stat.size, stat.mtimeMs] as [number, number];
    } catch {
      return null;
    }
  }));
}

export async function readJournal(workspacePath: string, slug: string): Promise<string> {
  await assertInCrewDir(workspacePath, journalPath(workspacePath, slug));
  return (await readTextIfExists(journalPath(workspacePath, slug))) ?? '';
}

export async function readNotes(workspacePath: string, slug: string): Promise<string> {
  await assertInCrewDir(workspacePath, notesPath(workspacePath, slug));
  return (await readTextIfExists(notesPath(workspacePath, slug))) ?? '';
}

/** The last `maxEntries` `## ` entries of a journal, bounded to `maxChars`. */
export function recentJournalEntries(journal: string, maxEntries = 5, maxChars = 8000): string {
  const entries = journal.split(/\n(?=## )/).filter((part) => part.startsWith('## '));
  let recent = entries.slice(-maxEntries).join('\n').trim();
  if (recent.length > maxChars) recent = `...${recent.slice(recent.length - maxChars)}`;
  return recent;
}

export async function appendJournalEntry(
  workspacePath: string,
  slug: string,
  entry: { heading: string; body: string },
): Promise<void> {
  await ensureMemoryFiles(workspacePath, slug);
  const body = entry.body.trim() || '(no summary)';
  await assertInCrewDir(workspacePath, journalPath(workspacePath, slug));
  await fs.appendFile(journalPath(workspacePath, slug), `\n## ${entry.heading.trim()}\n\n${body}\n`, 'utf8');
}

export async function appendNotesSection(
  workspacePath: string,
  slug: string,
  section: { heading: string; body: string },
): Promise<void> {
  await ensureMemoryFiles(workspacePath, slug);
  // Same lock as replaceNotes: an append landing between its read and rename would be lost.
  const filePath = notesPath(workspacePath, slug);
  await assertInCrewDir(workspacePath, filePath);
  await withFileLock(filePath, () => fs.appendFile(filePath, `\n## ${section.heading.trim()}\n\n${section.body.trim()}\n`, 'utf8'));
}

/** A short content hash an agent can quote back; the user's path compares content directly. */
export function notesRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** What a notes replacement was based on. Required: a replacement that read nothing overwrites blind. */
export type NotesBase = { content: string } | { revision: string };

function matchesBase(current: string, base: NotesBase): boolean {
  return 'content' in base ? current === base.content : notesRevision(current) === base.revision;
}

/**
 * Replaces notes only if the file still holds what the caller read, so a
 * correction saved in between (by the user or the member) is never
 * overwritten. The prior content is kept in `notes.previous.md` first.
 */
export async function replaceNotes(
  workspacePath: string,
  slug: string,
  content: string,
  base: NotesBase,
): Promise<void> {
  await ensureMemoryFiles(workspacePath, slug);
  const filePath = notesPath(workspacePath, slug);
  await assertInCrewDir(workspacePath, filePath);
  await assertInCrewDir(workspacePath, path.join(crewMemoryDir(workspacePath, slug), 'notes.previous.md'));
  await withFileLock(filePath, async () => {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = (await readTextIfExists(filePath)) ?? '';
      if (!matchesBase(current, base)) throw new CrewFileConflictError(filePath);
      if (current === content) return;
      if (current.trim()) {
        await writeFileAtomic(path.join(crewMemoryDir(workspacePath, slug), 'notes.previous.md'), current);
      }
      if (await replaceIfUnchanged(filePath, current, content)) return;
    }
    throw new CrewFileConflictError(filePath);
  });
}
