import * as path from 'path';

export function isTrackerSchemaFile(filePath: string): boolean {
  return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
}

export function shouldIgnoreTrackerWatchPath(trackersDir: string, candidatePath: string): boolean {
  if (candidatePath === trackersDir) return false;
  return path.basename(candidatePath).startsWith('.');
}
