/**
 * Host hooks for page marks: who a new mark is attributed to by default.
 * A host (desktop, web console) sets it once; with none set, `by` and `email`
 * start empty.
 */

export interface PageMarkAuthor {
  /** Display name, written as `by`. */
  name?: string | null;
  /** Stable identity, written as `email`. */
  email?: string | null;
}

type AuthorProvider = () => PageMarkAuthor | null | undefined;

let authorProvider: AuthorProvider | undefined;

export function setPageMarkAuthorProvider(provider: AuthorProvider | undefined): void {
  authorProvider = provider;
}

export function getDefaultPageMarkAuthor(): { by?: string; email?: string } {
  const author = authorProvider?.();
  const by = author?.name?.trim();
  const email = author?.email?.trim();
  return { ...(by ? { by } : {}), ...(email ? { email } : {}) };
}
