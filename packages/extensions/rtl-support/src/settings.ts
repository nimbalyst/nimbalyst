/**
 * Settings — manages RTL extension configuration.
 */

export type RtlMode = 'auto' | 'rtl' | 'ltr';

export interface RtlSettings {
  /** Whether the extension is enabled */
  enabled: boolean;
  /** Operating mode: auto = detect, rtl/ltr = force */
  mode: RtlMode;
  /** RTL ratio threshold for detection (default 0.3) */
  threshold: number;
  /** Per-block vs per-message detection */
  perBlock: boolean;
  /** Apply RTL to user input fields */
  inputRtl: boolean;
  /** Inline RTL detection within paragraphs */
  inlineDetect: boolean;
  /** Debug logging */
  debug: boolean;
}

const STORAGE_KEY = 'nimbalyst.rtl-support.settings';
const DEFAULT_SETTINGS: RtlSettings = {
  enabled: true,
  mode: 'auto',
  threshold: 0.3,
  perBlock: true,
  inputRtl: true,
  inlineDetect: false,
  debug: false,
};

export function loadSettings(): RtlSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const parsed = JSON.parse(raw) as Partial<RtlSettings>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SETTINGS.enabled,
      mode: ['auto', 'rtl', 'ltr'].includes(parsed.mode as string)
        ? (parsed.mode as RtlMode)
        : DEFAULT_SETTINGS.mode,
      threshold:
        typeof parsed.threshold === 'number' && parsed.threshold >= 0 && parsed.threshold <= 1
          ? parsed.threshold
          : DEFAULT_SETTINGS.threshold,
      perBlock: typeof parsed.perBlock === 'boolean' ? parsed.perBlock : DEFAULT_SETTINGS.perBlock,
      inputRtl: typeof parsed.inputRtl === 'boolean' ? parsed.inputRtl : DEFAULT_SETTINGS.inputRtl,
      inlineDetect:
        typeof parsed.inlineDetect === 'boolean' ? parsed.inlineDetect : DEFAULT_SETTINGS.inlineDetect,
      debug: typeof parsed.debug === 'boolean' ? parsed.debug : DEFAULT_SETTINGS.debug,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: RtlSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore — storage may be unavailable in sandboxed environments
  }
}

export function resetSettings(): RtlSettings {
  const defaults = { ...DEFAULT_SETTINGS };
  saveSettings(defaults);
  return defaults;
}
