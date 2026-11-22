/**
 * Run targets offered from `package.json` scripts when the project has no
 * `.nimbalyst/run.json` yet. Only scripts that conventionally stay running are
 * offered. Nothing is written until the user accepts one.
 */
import type { RunTarget } from '../shared/types';

/** Script names that usually start a long-running process, in the order offered. */
const LONG_RUNNING_SCRIPTS = ['dev', 'start', 'serve', 'watch'] as const;

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/** Lockfiles, checked in this order; the first present one names the package manager. */
export const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

export function packageManagerFor(presentFiles: ReadonlySet<string>): PackageManager {
  for (const [file, manager] of LOCKFILES) {
    if (presentFiles.has(file)) return manager;
  }
  return 'npm';
}

export function suggestTargets(
  packageJsonText: string | null,
  packageManager: PackageManager,
  existingIds: ReadonlySet<string> = new Set()
): RunTarget[] {
  if (!packageJsonText) return [];
  let scripts: unknown;
  try {
    scripts = (JSON.parse(packageJsonText) as { scripts?: unknown }).scripts;
  } catch {
    return [];
  }
  if (typeof scripts !== 'object' || scripts === null) return [];

  const suggestions: RunTarget[] = [];
  for (const script of LONG_RUNNING_SCRIPTS) {
    const body = (scripts as Record<string, unknown>)[script];
    if (typeof body !== 'string' || body.trim() === '' || existingIds.has(script)) continue;
    suggestions.push({ id: script, name: script, command: `${packageManager} run ${script}` });
  }
  return suggestions;
}
