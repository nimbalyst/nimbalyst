/**
 * Client-side search shared by the PR and issue lists.
 *
 * Free text matches the title, the number, the author login, and label names. `author:<login>` tokens narrow to rows whose author login
 * contains that text; several author tokens are a union, so
 * `author:alice author:bob` shows both people's rows. A leading `@` on the
 * login is ignored, matching how people paste GitHub handles.
 */

export interface GithubSearchableRow {
  title: string;
  number: number;
  authorLogin: string | null;
  /** Issues carry label objects; PRs carry bare label names. */
  labels?: ReadonlyArray<string | { name: string }>;
}

export interface ParsedGithubListSearch {
  text: string;
  authors: string[];
}

const AUTHOR_TOKEN = /^author:@?(.*)$/i;

export function parseGithubListSearch(search: string): ParsedGithubListSearch {
  const authors: string[] = [];
  const words: string[] = [];
  for (const token of search.trim().toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const match = AUTHOR_TOKEN.exec(token);
    if (match) {
      // A bare `author:` while the user is still typing narrows nothing.
      if (match[1]) authors.push(match[1]);
    } else {
      words.push(token);
    }
  }
  return { text: words.join(' '), authors };
}

export function matchesGithubListSearch(row: GithubSearchableRow, search: string): boolean {
  const { text, authors } = parseGithubListSearch(search);
  const author = row.authorLogin?.toLowerCase() ?? '';
  if (authors.length > 0 && !authors.some((a) => author.includes(a))) return false;
  if (!text) return true;
  const q = text.replace(/^@/, '');
  return (
    row.title.toLowerCase().includes(text) ||
    String(row.number).includes(text) ||
    (author !== '' && author.includes(q)) ||
    (row.labels ?? []).some((label) =>
      (typeof label === 'string' ? label : label.name).toLowerCase().includes(text),
    )
  );
}
