/**
 * The corpus the harness indexes.
 *
 * This mirrors the engine's default source set plus the phase-0 additions
 * (`.claude/rules/**` and `AGENTS.md`), because those hold the highest-value
 * conventions in the repo and the golden set targets them. It is deliberately
 * a *separate* declaration rather than an import of the host's `defaultSources`
 * — the harness must be able to score a corpus the shipped default does not yet
 * cover, which is the whole point of measuring a proposed change.
 *
 * Nothing downstream enumerates these classes: the per-class scorecard derives
 * its rows from what the index actually contains, so adding a source set here
 * (or the host adding one upstream) shows up in the report on its own.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { SourceSet } from '../types.js';

export const EVAL_FACTS_DIR = 'nimbalyst-local/voice-memory';

/**
 * Mirrors the host's exclude. Archived plans duplicate live design docs almost
 * verbatim, so indexing them would inflate the `plans` class with near-copies
 * of the very sections the golden set targets — a scorecard measured against a
 * corpus the product does not serve.
 */
export const EVAL_EXCLUDE = ['**/archive/**'];

export function evalSources(factsDir = EVAL_FACTS_DIR): SourceSet[] {
  return [
    { sourceClass: 'design', include: ['design/**/*.md'] },
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    { sourceClass: 'plans', include: ['nimbalyst-local/plans/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md', '**/CLAUDE.md', 'AGENTS.md', '**/AGENTS.md'] },
    { sourceClass: 'rules', include: ['.claude/rules/**/*.md'] },
    { sourceClass: 'facts', include: [`${factsDir}/**/*.md`] },
  ];
}

/**
 * Walk up from `start` to the nearest directory containing `.git`, so the
 * harness works from the package dir, the repo root, or anywhere in between.
 */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}
