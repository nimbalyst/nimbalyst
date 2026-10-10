/**
 * Which team project a command addresses, resolved the way the plugin's
 * `connect` skill does: `repo` is `git remote get-url origin`, and
 * `.nimbalyst/wiki.json` (`{ orgId, projectId }`) is an optional pin sent as
 * `project`. The pin only picks among projects the caller can already reach;
 * it never grants access.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { usageError } from '../cli/exitCodes.js';

/** The wiki.json pin, and the `project` argument of every Pages tool. */
export interface ProjectPin {
  orgId: string;
  projectId: string;
}

export interface TeamsTarget {
  /** The tools' `repo` argument; absent for a checkout with no `origin`. */
  repo?: string;
  /** Directory `.nimbalyst/wiki.json` lives in (git toplevel, or the start dir). */
  root: string;
  /** Sent as `project`; from --org/--project, else wiki.json unless --repo was given. */
  project?: ProjectPin;
  /** Where `project` came from, for error messages. */
  projectSource?: 'flags' | 'wiki.json';
}

function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The checkout's root (git toplevel, else the start dir) and its `origin` remote, if any. */
export function locateCheckout(startDir: string): { root: string; origin?: string } {
  const root = git(startDir, ['rev-parse', '--show-toplevel']) ?? startDir;
  return { root, origin: git(root, ['remote', 'get-url', 'origin']) };
}

export function wikiFilePath(root: string): string {
  return path.join(root, '.nimbalyst', 'wiki.json');
}

export function readProjectPin(root: string): ProjectPin | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(wikiFilePath(root), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw usageError(`${wikiFilePath(root)} is not valid JSON: ${err?.message ?? err}`);
  }
  // A file from the earlier GitHub-native wiki (`wikiId`, `joinSecret`) is not a pin; ignore it.
  if (typeof parsed?.orgId === 'string' && parsed.orgId && typeof parsed?.projectId === 'string' && parsed.projectId) {
    return { orgId: parsed.orgId, projectId: parsed.projectId };
  }
  return undefined;
}

/**
 * Writes the pin, keeping keys nim does not own. The earlier GitHub-native
 * `wikiId` and `joinSecret` are dropped: a pin carries no secret.
 */
export function writeProjectPin(root: string, pin: ProjectPin): void {
  const file = wikiFilePath(root);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // absent or unreadable: start fresh
  }
  const { wikiId: _w, joinSecret: _j, ...kept } = existing;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...kept, orgId: pin.orgId, projectId: pin.projectId }, null, 2) + '\n');
}

/**
 * An explicit `--repo` or `--org/--project` describes some other
 * target, so the current directory's wiki.json is not read at all: mixing a pin
 * for this checkout into a call about another repo would address the wrong
 * project.
 */
export function resolveTeamsTarget(
  startDir: string,
  opts: { repo?: string; project?: ProjectPin } = {},
): TeamsTarget {
  const { root, origin: repo } = locateCheckout(startDir);
  if (opts.repo || opts.project) {
    return {
      root,
      repo: opts.repo ?? repo,
      project: opts.project,
      projectSource: opts.project ? 'flags' : undefined,
    };
  }
  const project = readProjectPin(root);
  if (!repo && !project) {
    throw usageError(
      `No team project for ${root}: it has no 'origin' remote and no .nimbalyst/wiki.json pin. Pass --repo, or --org and --project.`,
    );
  }
  return { root, repo, project, projectSource: project ? 'wiki.json' : undefined };
}
