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

export interface OrganizationDirectoryEntry {
  orgId: string;
  name: string;
  role: string;
  membershipType?: string;
  sourcePersonalOrgId?: string;
  owningPersonalOrgId?: string | null;
  sourceEmail?: string | null;
  /** Project registry for the org; absent on snapshots from older workers. */
  projects?: Array<{ projectId: string; name: string | null; slug: string | null }>;
  /** Every signed-in account that resolved a membership in this org. */
  accountBindings?: Array<{ personalOrgId: string; teamMemberId: string }>;
  /** Account chosen from the explicit local binding — the one whose JWT this org uses. */
  boundPersonalOrgId?: string | null;
}

// These domains deliberately do not reference each other. Switching a personal
// sync account cannot mutate organization selection or project attachment.
export const personalAccountsAtom = atom<PersonalAccountSummary[]>([]);
export const personalSyncProfilesAtom = atom<Record<string, PersonalSyncProfileSummary>>({});
export const organizationDirectoryAtom = atom<OrganizationDirectoryEntry[]>([]);

/**
 * Whether org-creation affordances (New organization buttons,
 * create-team-from-workspace) render. Open to every build since the Teams alpha
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
