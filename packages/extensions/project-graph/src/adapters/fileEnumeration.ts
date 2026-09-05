/**
 * Filesystem enumeration shared by the plan and doc sources.
 *
 * Two things this fixes over the ad-hoc `find … | head -N` calls it replaces:
 *
 *  1. **`head -N` is a silent answer change.** It drops files with no record
 *    that it did so, and the surviving set depends on `find`'s traversal order
 *    rather than on anything meaningful. Enumeration here is complete up to an
 *    explicit safety maximum, sorted deterministically, and reports truncation.
 *  2. **Interpolating a path into a shell string is a correctness bug**, not
 *    just a security one — an apostrophe, a `$`, or a backtick in a filename
 *    silently produced the wrong command. Every path goes through
 *    {@link shellQuote}.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';

/**
 * POSIX single-quote a value for safe use as one shell word. A literal single
 * quote is closed, escaped, and reopened.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface EnumerationRequest {
  /** Workspace-relative directory roots. Missing roots are skipped, not fatal. */
  roots: readonly string[];
  /** `find -name` patterns, OR-ed together. */
  namePatterns: readonly string[];
  maxDepth: number;
  /**
   * Optional ceiling on returned paths. **Omitted means no limit.** Reaching a
   * ceiling that WAS set is REPORTED via `truncated`/`truncationReason`; it
   * never silently shortens the answer.
   */
  safetyMax?: number;
  timeoutMs?: number;
}

export interface EnumerationResult {
  /** Deterministically sorted, deduped, workspace-relative paths. */
  paths: string[];
  /** Total found before the safety maximum was applied. */
  found: number;
  truncated: boolean;
  truncationReason?: string;
  /** Roots whose `find` failed, with the reason. Empty on a clean run. */
  errors: string[];
}

/**
 * Enumerate matching files under each root.
 *
 * Roots are probed one command at a time so a failure is attributable to a
 * root instead of collapsing the whole run into one opaque exit code.
 */
export async function enumerateFiles(
  host: PanelHost,
  request: EnumerationRequest,
): Promise<EnumerationResult> {
  const nameExpr = request.namePatterns.map(p => `-name ${shellQuote(p)}`).join(' -o ');
  const all = new Set<string>();
  const errors: string[] = [];

  for (const root of request.roots) {
    const quoted = shellQuote(root);
    // `[ -d root ]` first so an absent root is an empty result rather than a
    // `find` error; a real failure inside an existing root still surfaces.
    const command =
      `if [ -d ${quoted} ]; then find ${quoted} -maxdepth ${request.maxDepth} -type f \\( ${nameExpr} \\) -print; fi`;
    let res;
    try {
      res = await host.exec(command, { timeout: request.timeoutMs ?? 15000, maxBuffer: 8 * 1024 * 1024 });
    } catch (err) {
      errors.push(`${root}: ${String(err).slice(0, 160)}`);
      continue;
    }
    if (!res.success) {
      errors.push(`${root}: ${(res.stderr || `exit ${res.exitCode}`).trim().slice(0, 160)}`);
      continue;
    }
    for (const line of res.stdout.split('\n')) {
      const path = line.trim();
      if (path) all.add(path);
    }
  }

  // Sorted in JS rather than by the shell: `sort` is locale-dependent, and a
  // stable order is what makes "the first N" a defensible selection when the
  // safety maximum does engage.
  const sorted = Array.from(all).sort();
  const safetyMax = request.safetyMax ?? Number.POSITIVE_INFINITY;
  const truncated = sorted.length > safetyMax;
  return {
    paths: truncated ? sorted.slice(0, safetyMax) : sorted,
    found: sorted.length,
    truncated,
    truncationReason: truncated
      ? `${sorted.length} files matched; stopped at the ${safetyMax} safety maximum.`
      : undefined,
    errors,
  };
}

const HEAD_MARKER = '__PG_FILE__:';

export interface FileHead {
  path: string;
  body: string;
}

/**
 * Read the first `bytes` of each path in batches.
 *
 * Batched because one `exec` per file is prohibitively slow at corpus scale,
 * and bounded per file so one enormous document cannot blow the buffer. Paths
 * are quoted and the marker is emitted with `printf` so a `$` or a backtick in
 * a filename cannot be interpreted.
 */
export async function readFileHeads(
  host: PanelHost,
  paths: readonly string[],
  options: { bytes?: number; batchSize?: number; timeoutMs?: number } = {},
): Promise<FileHead[]> {
  const bytes = options.bytes ?? 4000;
  const batchSize = options.batchSize ?? 100;
  const out: FileHead[] = [];

  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    const command = batch
      .map(p => `printf '%s\\n' ${shellQuote(`${HEAD_MARKER}${p}`)}; head -c ${bytes} ${shellQuote(p)}; printf '\\n'`)
      .join('; ');
    let res;
    try {
      res = await host.exec(command, { timeout: options.timeoutMs ?? 20000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      continue; // Skip this batch; a partial read beats no read.
    }
    if (!res.success && !res.stdout) continue;
    for (const block of res.stdout.split(HEAD_MARKER)) {
      if (!block) continue;
      const nl = block.indexOf('\n');
      const path = (nl >= 0 ? block.slice(0, nl) : block).trim();
      if (!path) continue;
      out.push({ path, body: nl >= 0 ? block.slice(nl + 1) : '' });
    }
  }

  return out;
}
