export interface FilterableGitCommit {
  hash: string;
  message: string;
  author: string;
}

export function filterCommits<T extends FilterableGitCommit>(commits: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return commits;

  return commits.filter(commit =>
    commit.message.toLocaleLowerCase().includes(normalizedQuery) ||
    commit.author.toLocaleLowerCase().includes(normalizedQuery) ||
    commit.hash.toLocaleLowerCase().startsWith(normalizedQuery)
  );
}
