import os from 'os';
import path from 'path';

const FILE_TOOL_RULE = /^(Read|Edit|Write)\((.*)\)$/;

function isWindowsPath(candidate: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\');
}

function normalizeCandidate(candidate: string): string {
  const resolved = isWindowsPath(candidate)
    ? path.win32.resolve(candidate)
    : path.resolve(candidate);
  return resolved.replace(/\\/g, '/');
}

function expandHome(pattern: string): string {
  if (pattern === '~') return os.homedir().replace(/\\/g, '/');
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) {
    return `${os.homedir().replace(/\\/g, '/')}/${pattern.slice(2)}`;
  }
  return pattern;
}

/**
 * Best-effort port of Claude Code's file-rule glob conversion. It is warning
 * only: the authoritative signal remains the SDK/CLI tool result.
 */
export function attachmentPathMatchesDenyRule(candidatePath: string, rule: string): boolean {
  const match = rule.trim().match(FILE_TOOL_RULE);
  if (!match) return false;

  const candidate = normalizeCandidate(candidatePath);
  const pattern = expandHome(match[2]).replace(/\\/g, '/');
  const globstar = '\u0000';
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/(?:\*\*\/)+/g, globstar)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .replace(new RegExp(globstar, 'g'), '(?:.*/)?');

  try {
    return new RegExp(`^${escaped}$`, isWindowsPath(candidatePath) ? 'is' : 's').test(candidate);
  } catch {
    return false;
  }
}

export function findAttachmentDenyRule(candidatePath: string, denyRules: string[]): string | null {
  return denyRules.find((rule) => attachmentPathMatchesDenyRule(candidatePath, rule)) ?? null;
}
