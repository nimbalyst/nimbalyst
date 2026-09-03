/**
 * On-disk size, in bytes.
 *
 * The shared traversal is iterative so a pathological directory tree can't
 * blow the stack. Both drivers swallow every filesystem error per-entry: this
 * feeds pre-flight sizing and telemetry gauges, neither of which should be
 * able to fail a launch because one file went away mid-walk.
 *
 * Returns 0 for a path that does not exist.
 */

import * as fs from 'fs';
import * as path from 'path';

type DirectorySizeRequest = { kind: 'lstat'; target: string } | { kind: 'readdir'; target: string };

type DirectorySizeResponse = fs.Stats | string[] | undefined;

function* traverseDirectorySize(root: string): Generator<DirectorySizeRequest, number, DirectorySizeResponse> {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const target = stack.pop()!;
    const stat = (yield { kind: 'lstat', target }) as fs.Stats | undefined;
    if (!stat) continue;

    if (stat.isDirectory()) {
      const entries = (yield { kind: 'readdir', target }) as string[] | undefined;
      if (!entries) continue;
      for (const entry of entries) stack.push(path.join(target, entry));
    } else if (stat.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

function performSync(request: DirectorySizeRequest): DirectorySizeResponse {
  try {
    return request.kind === 'lstat' ? fs.lstatSync(request.target) : fs.readdirSync(request.target);
  } catch {
    return undefined;
  }
}

async function performAsync(request: DirectorySizeRequest): Promise<DirectorySizeResponse> {
  try {
    return request.kind === 'lstat'
      ? await fs.promises.lstat(request.target)
      : await fs.promises.readdir(request.target);
  } catch {
    return undefined;
  }
}

export function dirSizeBytes(root: string): number {
  const traversal = traverseDirectorySize(root);
  let step = traversal.next();
  while (!step.done) step = traversal.next(performSync(step.value));
  return step.value;
}

export async function directorySizeBytes(root: string): Promise<number> {
  const traversal = traverseDirectorySize(root);
  let step = traversal.next();
  while (!step.done) step = traversal.next(await performAsync(step.value));
  return step.value;
}
