/**
 * Workspace resolution (wrangler-style precedence):
 *   1. --workspace flag
 *   2. NIM_WORKSPACE env
 *   3. walk up from cwd for a `.nimbalyst` marker directory
 *   4. if the gateway sees exactly one workspace, use it
 *   5. error, listing candidates
 *
 * Trackers are workspace-scoped, so every tracker command resolves one first.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TrackerGateway } from '../gateway/types.js';
import { usageError } from '../cli/exitCodes.js';

export async function resolveWorkspace(
  gateway: TrackerGateway,
  flagWorkspace?: string,
): Promise<string> {
  const explicit = flagWorkspace ?? process.env.NIM_WORKSPACE;
  if (explicit) return path.resolve(explicit);

  const fromCwd = findWorkspaceMarker(process.cwd());
  if (fromCwd) {
    // Confirm it's a workspace the gateway knows; if not, still honor it (the
    // user is clearly inside a project tree).
    return fromCwd;
  }

  const candidates = await gateway.listWorkspaces();
  if (candidates.length === 1) return candidates[0].path;

  if (candidates.length === 0) {
    throw usageError(
      'Could not resolve a workspace. Pass --workspace <path>, set NIM_WORKSPACE, or run from inside a Nimbalyst project.',
    );
  }

  const list = candidates.map((c) => `  - ${c.path}${c.name ? `  (${c.name})` : ''}`).join('\n');
  throw usageError(`Ambiguous workspace. Pass --workspace <path>. Candidates:\n${list}`);
}

/** Walk up from `start` looking for a `.nimbalyst` directory; return its parent. */
function findWorkspaceMarker(start: string): string | null {
  let dir = path.resolve(start);
  // Guard against symlink loops / root.
  for (let i = 0; i < 64; i++) {
    const marker = path.join(dir, '.nimbalyst');
    try {
      if (fs.statSync(marker).isDirectory()) return dir;
    } catch {
      /* not here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
