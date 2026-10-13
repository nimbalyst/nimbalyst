/**
 * Which of the workspace's repositories the GitHub panel lists pull requests
 * and issues for. Shown only when the workspace holds more than one, as an
 * umbrella repository with clones inside it, or attached folders (#908).
 */

import type { JSX } from 'react';
import { useAtomValue } from 'jotai';
import { workspaceRepoPathsAtom } from '../../store/atoms/workspaceRepos';
import { prRemoteAtom, prSelectedRepoAtom, selectPrRepo } from '../../store/atoms/pullRequests';
import { repoLabels } from '../../utils/workspaceRepos';

export function PrRepoPicker({ workspacePath }: { workspacePath: string }): JSX.Element | null {
  const repos = useAtomValue(workspaceRepoPathsAtom);
  const selected = useAtomValue(prSelectedRepoAtom);
  const remote = useAtomValue(prRemoteAtom);
  if (repos.length < 2) return null;

  const current = (selected?.workspacePath === workspacePath ? selected.repoPath : undefined)
    ?? (remote?.workspacePath === workspacePath ? remote.repoPath : undefined)
    ?? workspacePath;
  const labels = repoLabels(repos);

  return (
    <select
      className="pr-repo-picker px-2 py-1 rounded border border-nim bg-nim-secondary text-nim text-[12px] font-mono max-w-[200px] truncate"
      value={current}
      onChange={(e) => selectPrRepo(workspacePath, e.target.value)}
      aria-label="Repository"
      title={current}
      data-testid="pr-repo-picker"
    >
      {repos.map((repo) => (
        <option key={repo} value={repo}>{labels[repo] ?? repo}</option>
      ))}
    </select>
  );
}
