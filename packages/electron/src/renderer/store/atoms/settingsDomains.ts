import { atom, useAtom } from 'jotai';
import type { ProjectSettingsTarget } from '../../components/Settings/panels/ProjectSharingPanel';

export interface PersonalAccountSummary {
  personalOrgId: string;
  personalUserId: string | null;
  email: string | null;
  userName?: string;
  isSyncAccount: boolean;
  sessionStatus: 'active' | 'expired';
}

export interface PersonalSyncProfileSummary {
  enabledProjects: string[];
  docSyncEnabledProjects: string[];
  preventSleepMode?: 'off' | 'always' | 'pluggedIn';
}

export type { OrganizationDirectoryEntry } from '../../../shared/organizationDirectory';
import type { OrganizationDirectoryEntry, OrganizationDirectorySnapshot } from '../../../shared/organizationDirectory';

// These domains deliberately do not reference each other. Switching a personal
// sync account cannot mutate organization selection or project attachment.
export const personalAccountsAtom = atom<PersonalAccountSummary[]>([]);
export const personalSyncProfilesAtom = atom<Record<string, PersonalSyncProfileSummary>>({});
export const organizationDirectoryStateAtom = atom<OrganizationDirectorySnapshot>({
  entries: [], status: 'loading', complete: false,
});
// Legacy array consumers read the same snapshot; there is no second directory.
export const organizationDirectoryAtom = atom(
  (get) => get(organizationDirectoryStateAtom).entries,
  (_get, set, entries: OrganizationDirectoryEntry[]) => {
    set(organizationDirectoryStateAtom, { entries, status: 'ready', complete: true });
  },
);

/**
 * Whether org-creation affordances (New organization buttons,
 * create-team-from-workspace) render. Open to every build since the Teams beta
 * unlocked; flip this back to `import.meta.env.DEV` to re-lock packaged builds
 * to dev-only creation (NIM-2306 — the earlier lock was temporary, never an
 * invite-only program).
 */
export const organizationCreationEnabled = true;

/**
 * Whether the Teams/organization surfaces (settings routes, account org list,
 * org window entry points) should be visible at all. True while creation is
 * open, and otherwise once the account has any org membership — active or
 * pending invite — so invited users can still accept.
 */
export const teamsConfiguredAtom = atom((get) =>
  organizationCreationEnabled || get(organizationDirectoryAtom).length > 0);
export const projectSettingsContextAtom = atom<ProjectSettingsTarget | undefined>(undefined);

export const usePersonalAccounts = () => useAtom(personalAccountsAtom);
export const usePersonalSyncProfiles = () => useAtom(personalSyncProfilesAtom);
export const useOrganizationDirectory = () => useAtom(organizationDirectoryAtom);
