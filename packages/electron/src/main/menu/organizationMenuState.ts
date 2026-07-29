/**
 * Visibility state for the "Organization Manager" menu item.
 *
 * Organizations are invite-only while Teams is in alpha, so the menu entry only
 * shows once the account is known to belong to at least one org. TeamService
 * reports that from listTeams(); ApplicationMenu registers the rebuild callback
 * (a registration rather than a direct import so this module does not create a
 * TeamService -> ApplicationMenu -> ... import cycle).
 */

let hasOrganizations = false;
let rebuildMenu: (() => void) | null = null;

export function getHasOrganizationsForMenu(): boolean {
  return hasOrganizations;
}

export function setHasOrganizationsForMenu(next: boolean): void {
  if (next === hasOrganizations) return;
  hasOrganizations = next;
  rebuildMenu?.();
}

export function registerOrganizationMenuRebuild(callback: () => void): void {
  rebuildMenu = callback;
}
