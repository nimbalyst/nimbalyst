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
export const projectSettingsContextAtom = atom<ProjectSettingsTarget | undefined>(undefined);

export const usePersonalAccounts = () => useAtom(personalAccountsAtom);
export const usePersonalSyncProfiles = () => useAtom(personalSyncProfilesAtom);
export const useOrganizationDirectory = () => useAtom(organizationDirectoryAtom);
