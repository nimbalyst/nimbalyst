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
