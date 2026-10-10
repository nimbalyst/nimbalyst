/**
 * Types the app could not load, read from the Local wiki snapshot's
 * `malformed-type` issues. The Local section shows each one, marked broken,
 * so the user sees there is a problem instead of a table or typed pages
 * silently missing (NIM-7437).
 */
import type { SharedTypePlacement } from '@nimbalyst/collab-client/docs';
import type { LocalPage } from '@nimbalyst/local-wiki';

interface IssueLike {
  code?: unknown;
  path?: unknown;
  message?: unknown;
  id?: unknown;
}

/** Type id to the reason its file did not load, with the file named. */
export function brokenTypesFromIssues(issues: readonly unknown[] | undefined): Record<string, string> {
  const broken: Record<string, string> = {};
  for (const raw of issues ?? []) {
    const issue = raw as IssueLike;
    if (issue?.code !== 'malformed-type' || typeof issue.path !== 'string') continue;
    const fileName = issue.path.split(/[\\/]/).pop() ?? issue.path;
    const typeId = typeof issue.id === 'string' && issue.id ? issue.id : fileName.replace(/\.ya?ml$/, '');
    if (!typeId || broken[typeId]) continue;
    broken[typeId] = `${typeof issue.message === 'string' ? issue.message : 'unreadable'} (.nimbalyst/trackers/${fileName})`;
  }
  return broken;
}

/**
 * A root placement for each broken type the wiki does not already show: one
 * with no table placement and no typed page. Without it a broken type nothing
 * refers to would still be invisible.
 */
export function placementsForUnshownBrokenTypes(
  broken: Readonly<Record<string, string>>,
  typePlacements: readonly SharedTypePlacement[],
  pages: readonly LocalPage[],
): SharedTypePlacement[] {
  const shown = new Set(typePlacements.map((placement) => placement.typeId));
  for (const page of pages) if (page.type && page.trashedAt === null) shown.add(page.type);
  return Object.keys(broken)
    .filter((typeId) => !shown.has(typeId))
    .sort()
    .map((typeId) => ({
      typeId,
      projectId: null,
      parentFolderId: null,
      // After every real root entry.
      sortOrder: Number.MAX_SAFE_INTEGER,
      createdBy: 'local-wiki',
      createdAt: 0,
      updatedAt: 0,
    }));
}

/** Same content, so an unchanged snapshot keeps the resolver memo. */
export function sameBrokenTypes(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
