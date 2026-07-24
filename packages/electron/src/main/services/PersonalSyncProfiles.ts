export interface PersonalSyncProfile {
  enabledProjects: string[];
  docSyncEnabledProjects: string[];
  preventSleepMode?: 'off' | 'always' | 'pluggedIn';
}

export interface PersonalSyncProfilesConfig {
  enabled: boolean;
  serverUrl: string;
  enabledProjects?: string[];
  docSyncEnabledProjects?: string[];
  personalOrgId?: string;
  personalUserId?: string;
  preventSleepMode?: 'off' | 'always' | 'pluggedIn';
  personalSyncProfiles?: Record<string, PersonalSyncProfile>;
}

type Profiled<T> = T & { personalSyncProfiles?: Record<string, PersonalSyncProfile> };

function currentProfile(config: PersonalSyncProfilesConfig): PersonalSyncProfile {
  return {
    enabledProjects: [...(config.enabledProjects ?? [])],
    docSyncEnabledProjects: [...(config.docSyncEnabledProjects ?? [])],
    preventSleepMode: config.preventSleepMode,
  };
}

export function migratePersonalSyncProfiles<T extends PersonalSyncProfilesConfig>(config: T): Profiled<T> {
  if (config.personalSyncProfiles || !config.personalOrgId) return config;
  return {
    ...config,
    personalSyncProfiles: {
      [config.personalOrgId]: currentProfile(config),
    },
  };
}

export function persistActivePersonalSyncProfile<T extends PersonalSyncProfilesConfig>(input: T): Profiled<T> {
  const config = migratePersonalSyncProfiles(input);
  if (!config.personalOrgId) return config;
  return {
    ...config,
    personalSyncProfiles: {
      ...(config.personalSyncProfiles ?? {}),
      [config.personalOrgId]: currentProfile(config),
    },
  };
}

export function switchPersonalSyncProfile<T extends PersonalSyncProfilesConfig>(
  input: T,
  account: { personalOrgId: string; personalUserId?: string },
): Profiled<T> {
  const config = migratePersonalSyncProfiles(input);
  const profiles = { ...(config.personalSyncProfiles ?? {}) };
  if (config.personalOrgId) profiles[config.personalOrgId] = currentProfile(config);
  const target = profiles[account.personalOrgId] ?? {
    enabledProjects: [],
    docSyncEnabledProjects: [],
    preventSleepMode: config.preventSleepMode,
  };
  profiles[account.personalOrgId] = target;

  return {
    ...config,
    personalOrgId: account.personalOrgId,
    personalUserId: account.personalUserId,
    enabled: target.enabledProjects.length > 0,
    enabledProjects: [...target.enabledProjects],
    docSyncEnabledProjects: [...target.docSyncEnabledProjects],
    preventSleepMode: target.preventSleepMode,
    personalSyncProfiles: profiles,
  };
}
