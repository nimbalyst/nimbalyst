import {
  DEFAULT_DICTATION_SETTINGS,
  type DictationEngineSetting,
  type DictationSettings,
} from '../../../shared/dictation';

const ENGINE_SETTINGS: DictationEngineSetting[] = ['auto', 'on-device', 'openai'];

/** Coerce a stored or renderer-supplied value into valid settings. */
export function normalizeDictationSettings(value: unknown): DictationSettings {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const settings: DictationSettings = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_DICTATION_SETTINGS.enabled,
    engine: ENGINE_SETTINGS.includes(raw.engine as DictationEngineSetting)
      ? (raw.engine as DictationEngineSetting)
      : DEFAULT_DICTATION_SETTINGS.engine,
  };
  if (typeof raw.language === 'string' && raw.language.trim()) {
    settings.language = raw.language.trim();
  }
  return settings;
}
