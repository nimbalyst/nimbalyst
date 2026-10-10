/**
 * A Team page is read by teammates on their own machines, so a link to a file
 * on this disk opens nothing for them. An agent asked to "add a diagram to the
 * wiki" wrote it to `docs/architecture.excalidraw` and linked that path from a
 * Team page, then reported the job done (NIM-7397). The page tools now say so
 * in their result, which is where the agent will read it.
 */

const LINK_TARGET = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
const FILE_EXTENSION = /\.[a-z0-9]{1,12}$/i;

/** Whether a link target names a file on this machine rather than something a teammate can open. */
export function isLocalFileTarget(target: string): boolean {
  const path = target.split(/[?#]/, 1)[0] ?? '';
  if (!path) return false;
  if (/^file:/i.test(path) || WINDOWS_DRIVE.test(path)) return true;
  if (HAS_SCHEME.test(path)) return false;
  if (path.startsWith('//')) return false;
  if (path.startsWith('/') || path.startsWith('~/')) return true;
  return path.startsWith('./') || path.startsWith('../') || FILE_EXTENSION.test(path);
}

/** The local file targets linked or embedded in this markdown, each once. */
export function localFileLinks(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(LINK_TARGET)) {
    const target = match[1]!;
    if (isLocalFileTarget(target)) found.add(target);
  }
  return [...found];
}

/** A warning for the tool result when text written to a Team page links local files; null otherwise. */
export function teamPageLocalLinkWarning(uri: string, texts: readonly unknown[]): string | null {
  if (!uri.startsWith('collab://')) return null;
  const links = [...new Set(texts.flatMap((text) => (typeof text === 'string' ? localFileLinks(text) : [])))];
  if (links.length === 0) return null;
  const shown = links.slice(0, 3).join(', ') + (links.length > 3 ? `, and ${links.length - 3} more` : '');
  return `Warning: this Team page now links to a file on this computer (${shown}). Teammates cannot open it. `
    + "Put that content in a Team page instead (createSharedDoc under this page; documentType 'excalidraw' for a drawing, with the file's JSON as initialContent) and link that page.";
}
