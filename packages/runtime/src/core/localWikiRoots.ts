/**
 * The Local wiki folder of each open workspace, as the host resolved it (the
 * location setting lives in the app, not here). Files inside one are Local
 * wiki pages: their flat `type:` frontmatter makes a typed page, and an
 * agent's edit to one lands as final text.
 */

const wikiRoots = new Map<string, string>();

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The host names the Local wiki folder of a workspace (null forgets it). */
export function setLocalWikiRoot(workspacePath: string, root: string | null): void {
  if (root) wikiRoots.set(workspacePath, normalize(root));
  else wikiRoots.delete(workspacePath);
}

export function isInLocalWikiRoot(filePath: string): boolean {
  const file = normalize(filePath);
  for (const root of wikiRoots.values()) {
    if (file.startsWith(`${root}/`)) return true;
  }
  return false;
}
