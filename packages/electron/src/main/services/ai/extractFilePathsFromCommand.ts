import * as path from 'path';

/** Shared lexical candidates; callers apply their own observation/filesystem checks. */
export function extractFilePathsFromCommand(command: string, cwd: string): string[] {
  const normalizedCommand = command.replace(/\\/g, path.sep);
  const candidates: string[] = [];
  const absoluteMatches = [
    ...(normalizedCommand.match(/\/[^\s'"]+/g) || []),
    ...(normalizedCommand.match(/[A-Za-z]:[\\\/][^\s'"]+/g) || []),
  ];
  for (const raw of absoluteMatches) {
    const cleaned = raw.replace(/[);:,]+$/, '');
    if (!cleaned) continue;
    candidates.push(path.normalize(cleaned));
  }
  const tokens = normalizedCommand.split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    const cleaned = token.replace(/^['"]|['"]$/g, '').replace(/[);:,]+$/, '');
    if (!cleaned || path.isAbsolute(cleaned)) continue;
    if (!cleaned.includes(path.sep) && !cleaned.includes('/')) continue;
    candidates.push(path.normalize(path.resolve(cwd, cleaned)));
  }
  return candidates;
}
