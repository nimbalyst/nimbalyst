/**
 * Selected-org state for the in-app Team surface.
 *
 * The Team surface targets the org selected in `OrgSwitcher` when present and
 * otherwise falls back to the active workspace's bound organization.
 *
 * `null` means no organization is selected. It is unrelated to the selected
 * personal/mobile sync account.
 */

import { atom } from 'jotai';

/** The org id explicitly selected for the Team surface, or null for workspace fallback. */
export const selectedOrgIdAtom = atom<string | null>(null);

/**
 * Bumped whenever the workspace's organization may have changed — creating one
 * is the case that matters, since the surfaces showing it resolve once per
 * workspace and would otherwise keep reporting "No organization" for the life
 * of the window. Read by `useProjectOrg`.
 */
export const projectOrgRevisionAtom = atom(0);
