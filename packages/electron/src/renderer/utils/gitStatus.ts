import type { GitStatus } from '../store/atoms/gitOperations';

export function normalizeGitStatus(value: unknown): GitStatus | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<GitStatus>;
  if (
    typeof candidate.branch !== 'string'
    || candidate.branch.trim().length === 0
    || typeof candidate.ahead !== 'number'
    || typeof candidate.behind !== 'number'
    || typeof candidate.hasUncommitted !== 'boolean'
  ) {
    return null;
  }

  return {
    branch: candidate.branch.trim(),
    ahead: candidate.ahead,
    behind: candidate.behind,
    hasUncommitted: candidate.hasUncommitted,
    ...(typeof candidate.baseBranch === 'string' ? { baseBranch: candidate.baseBranch } : {}),
    ...(typeof candidate.isMerged === 'boolean' ? { isMerged: candidate.isMerged } : {}),
  };
}
