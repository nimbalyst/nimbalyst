export interface SessionProgressNamingConfig {
  enabled: boolean;
  cadenceTurns: number;
  titleTemplate: string;
}

export const DEFAULT_SESSION_PROGRESS_NAMING_CONFIG: SessionProgressNamingConfig = {
  enabled: false,
  cadenceTurns: 10,
  titleTemplate: '',
};

let sessionProgressNamingConfig: SessionProgressNamingConfig = DEFAULT_SESSION_PROGRESS_NAMING_CONFIG;

export function normalizeSessionProgressNamingConfig(
  input: Partial<SessionProgressNamingConfig> | null | undefined
): SessionProgressNamingConfig {
  const rawCadence = Number(input?.cadenceTurns);
  const cadenceTurns = Number.isFinite(rawCadence)
    ? Math.max(1, Math.min(50, Math.round(rawCadence)))
    : DEFAULT_SESSION_PROGRESS_NAMING_CONFIG.cadenceTurns;
  const rawTemplate = typeof input?.titleTemplate === 'string' ? input.titleTemplate.trim() : '';
  const titleTemplate = rawTemplate.includes('{name}')
    ? rawTemplate.slice(0, 200)
    : DEFAULT_SESSION_PROGRESS_NAMING_CONFIG.titleTemplate;

  return {
    enabled: input?.enabled === true,
    cadenceTurns,
    titleTemplate,
  };
}

export function setSessionProgressNamingConfig(
  input: Partial<SessionProgressNamingConfig> | null | undefined
): void {
  sessionProgressNamingConfig = normalizeSessionProgressNamingConfig(input);
}

export function getSessionProgressNamingConfig(): SessionProgressNamingConfig {
  return sessionProgressNamingConfig;
}
