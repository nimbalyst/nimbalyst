/**
 * Pure helpers for picking a GitHub Release asset that we want to install as
 * a Nimbalyst extension. Split out from ExtensionMarketplaceHandlers.ts so it
 * can be unit-tested without pulling in `electron` and other side-effectful
 * dependencies.
 */

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  content_type?: string;
}

export interface SelectReleaseAssetOptions {
  /** GitHub repo name (the part after the slash). Used for "name contains repo name" tiebreaks. */
  repoName: string;
  /** Optional subdirectory from `/tree/<branch>/<subdir>` URLs. When set, the asset name must start with this. */
  subdir?: string;
}

/**
 * Pick the best release asset to install, or null if none qualifies.
 *
 * Selection rules (decided in the design discussion):
 *
 *  - We accept `.nimext` and `.zip` assets. The `.zip` case is validated
 *    identically to `.nimext` later -- it must contain a top-level
 *    `manifest.json`.
 *  - With a subdir (monorepo URL): the asset name must start with the LAST
 *    path segment of the subdir (case-insensitive). Asset filenames are
 *    flat -- they have no `/` -- so matching against the full subdir
 *    string never works for nested paths like
 *    `packages/extensions/mockuplm`. We match on `mockuplm` instead, which
 *    is the natural CI convention. `.nimext` is preferred over `.zip`. No
 *    name match returns null so the caller falls through to clone-source.
 *  - Without a subdir: prefer `.nimext` over `.zip`. When multiple match,
 *    prefer an asset whose filename contains the repo name; otherwise pick
 *    the first asset of that type in registration order.
 */
export function selectReleaseAsset(
  assets: ReadonlyArray<GitHubReleaseAsset>,
  { repoName, subdir }: SelectReleaseAssetOptions,
): GitHubReleaseAsset | null {
  const nimext = assets.filter(a => a.name.toLowerCase().endsWith('.nimext'));
  const zip = assets.filter(a => a.name.toLowerCase().endsWith('.zip'));

  if (subdir) {
    const lastSegment = subdir.split('/').filter(Boolean).pop() ?? subdir;
    const prefix = lastSegment.toLowerCase();
    return (
      nimext.find(a => a.name.toLowerCase().startsWith(prefix)) ??
      zip.find(a => a.name.toLowerCase().startsWith(prefix)) ??
      null
    );
  }

  const repoLower = repoName.toLowerCase();
  if (nimext.length === 1) return nimext[0];
  if (nimext.length > 1) {
    return nimext.find(a => a.name.toLowerCase().includes(repoLower)) ?? nimext[0];
  }
  if (zip.length === 1) return zip[0];
  if (zip.length > 1) {
    return zip.find(a => a.name.toLowerCase().includes(repoLower)) ?? zip[0];
  }
  return null;
}
