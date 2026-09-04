/**
 * The default source sets. ONE implementation, shared by both launchers — the
 * in-process backend (`src/backend.ts`) and the stdio launcher (`serve.ts`) each
 * had their own copy and they had already drifted.
 *
 * Host-agnostic: these are glob strings and directory paths, nothing about
 * Nimbalyst leaks in. The harness-memory root is derived from the workspace path
 * and the home directory, both passed in.
 */
import os from 'node:os';
import path from 'node:path';
import type { SourceSet } from './types.js';

/** Root id for the harness memory directory. Persisted key — see `SourceRoot.id`. */
export const HARNESS_MEMORY_ROOT_ID = 'harness-memory';

/**
 * The directory-name slug the Claude Code harness derives from an absolute
 * workspace path: every character outside `[A-Za-z0-9]` becomes `-`, so
 * `/Users/me/src/proj` becomes `-Users-me-src-proj`. Verified against all 37
 * project directories present under `~/.claude/projects` on this machine.
 */
export function harnessProjectSlug(workspacePath: string): string {
  return path.resolve(workspacePath).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Absolute path to the harness's curated memory directory for a workspace:
 * `~/.claude/projects/<slug>/memory`. Machine-local and personal — see the
 * `personal` flag on the source set below.
 */
export function harnessMemoryDir(workspacePath: string, homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude', 'projects', harnessProjectSlug(workspacePath), 'memory');
}

/**
 * Default markdown source sets for a workspace.
 *
 * `.claude/rules/**` and `AGENTS.md` are the project's operative conventions —
 * as load-bearing as `CLAUDE.md`, which was already indexed — and were
 * previously invisible to retrieval. The harness memory directory is a second
 * root (it lives outside the workspace) and is flagged personal.
 */
export function defaultSources(factsDir: string, workspacePath: string): SourceSet[] {
  return [
    { sourceClass: 'design', include: ['design/**/*.md'] },
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    // Plans/decisions/bugs already live as frontmatter markdown here, which is
    // also how they project into tracker items (fm:<type>:<path>), so indexing
    // these globs already grounds the agent in tracker content for v1.
    { sourceClass: 'plans', include: ['nimbalyst-local/plans/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md', '**/CLAUDE.md'] },
    // Agent-facing conventions — as load-bearing as CLAUDE.md, which was
    // already indexed. Kept a distinct class from 'claude' so the coverage
    // breakdown shows whether rules are actually reaching retrieval.
    //
    // The root-anchored `.claude/rules/**/*.md` is redundant with the `**/`
    // form for matching, but it gives the watcher a real base directory to
    // watch instead of a snapshot of individual files, so a newly-added rule
    // gets indexed without a restart.
    {
      sourceClass: 'rules',
      include: ['.claude/rules/**/*.md', '**/.claude/rules/**/*.md', 'AGENTS.md', '**/AGENTS.md'],
    },
    { sourceClass: 'facts', include: [`${factsDir}/**/*.md`] },
    {
      sourceClass: 'harness-memory',
      include: ['**/*.md'],
      root: {
        id: HARNESS_MEMORY_ROOT_ID,
        path: harnessMemoryDir(workspacePath),
        // Curated, machine-local, and about the user as much as the project.
        // Must not reach a committed replica or team sync.
        personal: true,
      },
    },
  ];
}
