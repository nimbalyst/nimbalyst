/**
 * App Settings Atoms
 *
 * Global application settings stored via Jotai atoms.
 * These settings are persisted via IPC to electron-store.
 *
 * Phase 1: Voice Mode Settings
 * - Fixes the bug where VoiceModeButton doesn't update when settings change
 * - Both SettingsView and VoiceModeButton subscribe to the same atom
 *
 * Key principles:
 * - Single source of truth for settings that affect multiple components
 * - Debounced writes to avoid excessive IPC traffic
 * - Derived atoms for easy consumption
 * - Setter atoms that update and trigger persist
 */

import { atom, type Atom } from 'jotai';
import posthog from 'posthog-js';
import { copyToClipboard } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { type EffortLevel, DEFAULT_EFFORT_LEVEL, parseEffortLevel } from '@nimbalyst/runtime/ai/server/effortLevels';
import { AlphaFeatureTag, getDefaultAlphaFeatures } from '../../../shared/alphaFeatures';
import { BetaFeatureTag } from '../../../shared/betaFeatures';
import { DeveloperFeatureTag, DEVELOPER_FEATURES, getDefaultDeveloperFeatures, enableAllDeveloperFeatures, disableAllDeveloperFeatures, areAllDeveloperFeaturesEnabled } from '../../../shared/developerFeatures';
import { normalizeCodexProviderConfig, omitModelsField, stripTransientProviderFields } from '@nimbalyst/runtime/ai/server/utils/modelConfigUtils';

// Voice type - all available OpenAI Realtime voices
export type VoiceId = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';

export interface TurnDetectionConfig {
  mode: 'server_vad' | 'push_to_talk';
  vadThreshold?: number;
  silenceDuration?: number;
  interruptible?: boolean;
}

export interface SystemPromptConfig {
  prepend?: string;
  append?: string;
}

export interface VoiceModeSettings {
  enabled: boolean;
  voice: VoiceId;
  turnDetection: TurnDetectionConfig;
  voiceAgentPrompt: SystemPromptConfig;
  codingAgentPrompt: SystemPromptConfig;
  submitDelayMs: number;
  /** How long (ms) to keep listening after speech ends before sleeping. Default 15000. */
  listenWindowMs: number;
}

/**
 * Default voice mode settings.
 */
const defaultVoiceModeSettings: VoiceModeSettings = {
  enabled: false,
  voice: 'alloy',
  turnDetection: {
    mode: 'server_vad',
    vadThreshold: 0.5,
    silenceDuration: 500,
    interruptible: true,
  },
  voiceAgentPrompt: {},
  codingAgentPrompt: {},
  submitDelayMs: 3000,
  listenWindowMs: 15000,
};

/**
 * The main voice mode settings atom.
 * Should be initialized from IPC on app load.
 */
export const voiceModeSettingsAtom = atom<VoiceModeSettings>(defaultVoiceModeSettings);

/**
 * Debounce timer for persistence.
 */
let persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 1000;

/**
 * Persist voice mode settings to main process.
 * Debounced to avoid excessive IPC calls during rapid changes.
 */
function schedulePersist(settings: VoiceModeSettings): void {
  if (persistDebounceTimer) {
    clearTimeout(persistDebounceTimer);
  }
  persistDebounceTimer = setTimeout(() => {
    persistDebounceTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.invoke('voice-mode:set-settings', settings);
    }
  }, PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * Voice mode enabled state.
 * Use this in components that only need to know if voice mode is enabled.
 */
export const voiceModeEnabledAtom = atom(
  (get) => get(voiceModeSettingsAtom).enabled
);

/**
 * Selected voice.
 */
export const selectedVoiceAtom = atom(
  (get) => get(voiceModeSettingsAtom).voice
);

/**
 * Turn detection config.
 */
export const turnDetectionAtom = atom(
  (get) => get(voiceModeSettingsAtom).turnDetection
);

// === Setter atoms ===

/**
 * Set voice mode settings (partial update).
 * Merges with existing settings and triggers persist.
 */
export const setVoiceModeSettingsAtom = atom(
  null,
  (get, set, updates: Partial<VoiceModeSettings>) => {
    const current = get(voiceModeSettingsAtom);
    const newSettings = { ...current, ...updates };

    // Track when voice mode is enabled/disabled
    if (updates.enabled !== undefined && updates.enabled !== current.enabled) {
      posthog.capture(updates.enabled ? 'voice_mode_enabled' : 'voice_mode_disabled');
    }

    set(voiceModeSettingsAtom, newSettings);
    schedulePersist(newSettings);
  }
);

/**
 * Toggle voice mode enabled.
 */
export const toggleVoiceModeEnabledAtom = atom(
  null,
  (get, set, enabled: boolean) => {
    const current = get(voiceModeSettingsAtom);
    const newSettings = { ...current, enabled };
    set(voiceModeSettingsAtom, newSettings);
    schedulePersist(newSettings);
  }
);

/**
 * Set turn detection config (partial update).
 */
export const setTurnDetectionAtom = atom(
  null,
  (get, set, updates: Partial<TurnDetectionConfig>) => {
    const current = get(voiceModeSettingsAtom);
    const newTurnDetection = { ...current.turnDetection, ...updates };
    const newSettings = { ...current, turnDetection: newTurnDetection };
    set(voiceModeSettingsAtom, newSettings);
    schedulePersist(newSettings);
  }
);

/**
 * Initialize voice mode settings from IPC.
 * Call this once at app startup.
 */
export async function initVoiceModeSettings(): Promise<VoiceModeSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return defaultVoiceModeSettings;
  }

  try {
    await window.electronAPI.invoke('voice-mode:init');
    const settings = await window.electronAPI.invoke('voice-mode:get-settings');

    if (settings) {
      return {
        enabled: settings.enabled || false,
        voice: settings.voice || 'alloy',
        turnDetection: settings.turnDetection || defaultVoiceModeSettings.turnDetection,
        voiceAgentPrompt: settings.voiceAgentPrompt || {},
        codingAgentPrompt: settings.codingAgentPrompt || {},
        submitDelayMs: settings.submitDelayMs ?? 3000,
        listenWindowMs: settings.listenWindowMs ?? 15000,
      };
    }
  } catch (error) {
    console.error('[appSettings] Failed to load voice mode settings:', error);
  }

  return defaultVoiceModeSettings;
}

// ============================================================================
// PHASE 2: Notification Settings
// ============================================================================

export type CompletionSoundType = 'chime' | 'bell' | 'pop' | 'custom' | 'none';

export interface NotificationSettings {
  completionSoundEnabled: boolean;
  completionSoundType: CompletionSoundType;
  /** Basename of the user-supplied custom sound file (display only), or null. */
  completionSoundCustomName: string | null;
  /** Completion sound volume as a percentage of system volume (0-100). */
  completionSoundVolume: number;
  osNotificationsEnabled: boolean;
  /** Show OS notifications even when app is focused, unless viewing that session */
  notifyWhenFocused: boolean;
  /** Show OS notifications when a session needs user input (permission, question, etc.) */
  sessionBlockedNotificationsEnabled: boolean;
}

/**
 * Default notification settings.
 */
const defaultNotificationSettings: NotificationSettings = {
  completionSoundEnabled: false,
  completionSoundType: 'chime',
  completionSoundCustomName: null,
  completionSoundVolume: 100,
  osNotificationsEnabled: false,
  notifyWhenFocused: false,
  sessionBlockedNotificationsEnabled: true,
};

/**
 * The main notification settings atom.
 * Should be initialized from IPC on app load.
 */
export const notificationSettingsAtom = atom<NotificationSettings>(defaultNotificationSettings);

/**
 * Debounce timer for notification settings persistence.
 */
let notificationPersistTimer: ReturnType<typeof setTimeout> | null = null;
const NOTIFICATION_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist notification settings to main process.
 * Debounced to avoid excessive IPC calls during rapid changes.
 */
function scheduleNotificationPersist(settings: NotificationSettings): void {
  if (notificationPersistTimer) {
    clearTimeout(notificationPersistTimer);
  }
  notificationPersistTimer = setTimeout(async () => {
    notificationPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      await window.electronAPI.invoke('completion-sound:set-enabled', settings.completionSoundEnabled);
      await window.electronAPI.invoke('completion-sound:set-type', settings.completionSoundType);
      await window.electronAPI.invoke('completion-sound:set-volume', settings.completionSoundVolume);
      await window.electronAPI.invoke('notifications:set-enabled', settings.osNotificationsEnabled);
      await window.electronAPI.invoke('notifications:set-notify-when-focused', settings.notifyWhenFocused);
      await window.electronAPI.invoke('notifications:set-blocked-enabled', settings.sessionBlockedNotificationsEnabled);
    }
  }, NOTIFICATION_PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * Completion sound enabled state.
 */
export const completionSoundEnabledAtom = atom(
  (get) => get(notificationSettingsAtom).completionSoundEnabled
);

/**
 * Completion sound type.
 */
export const completionSoundTypeAtom = atom(
  (get) => get(notificationSettingsAtom).completionSoundType
);

/**
 * Completion sound volume (0-100, as a percentage of system volume).
 */
export const completionSoundVolumeAtom = atom(
  (get) => get(notificationSettingsAtom).completionSoundVolume
);

/**
 * OS notifications enabled state.
 */
export const osNotificationsEnabledAtom = atom(
  (get) => get(notificationSettingsAtom).osNotificationsEnabled
);

/**
 * Notify when focused (unless viewing that session).
 */
export const notifyWhenFocusedAtom = atom(
  (get) => get(notificationSettingsAtom).notifyWhenFocused
);

/**
 * Session blocked notifications enabled state.
 */
export const sessionBlockedNotificationsEnabledAtom = atom(
  (get) => get(notificationSettingsAtom).sessionBlockedNotificationsEnabled
);

// === Setter atoms ===

/**
 * Set notification settings (partial update).
 * Merges with existing settings and triggers persist.
 */
export const setNotificationSettingsAtom = atom(
  null,
  (get, set, updates: Partial<NotificationSettings>) => {
    const current = get(notificationSettingsAtom);
    const newSettings = { ...current, ...updates };
    set(notificationSettingsAtom, newSettings);
    scheduleNotificationPersist(newSettings);
  }
);

/**
 * Initialize notification settings from IPC.
 * Call this once at app startup.
 */
export async function initNotificationSettings(): Promise<NotificationSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return defaultNotificationSettings;
  }

  try {
    const [soundEnabled, soundType, customSound, soundVolume, osNotifEnabled, notifyFocused, blockedEnabled] = await Promise.all([
      window.electronAPI.invoke('completion-sound:is-enabled'),
      window.electronAPI.invoke('completion-sound:get-type'),
      window.electronAPI.invoke('completion-sound:get-custom'),
      window.electronAPI.invoke('completion-sound:get-volume'),
      window.electronAPI.invoke('notifications:get-enabled'),
      window.electronAPI.invoke('notifications:get-notify-when-focused'),
      window.electronAPI.invoke('notifications:get-blocked-enabled'),
    ]);

    const customName: string | null = customSound?.fileName ?? null;
    let resolvedType: CompletionSoundType = soundType ?? 'chime';
    // Reconcile a stuck 'custom' type whose backing file is gone (deleted
    // out-of-band, or never chosen) back to a built-in sound, and persist it so
    // the store does not stay diverged. Renderer is the single writer of type.
    if (resolvedType === 'custom' && !customName) {
      resolvedType = 'chime';
      window.electronAPI.invoke('completion-sound:set-type', 'chime').catch(() => {});
    }

    return {
      completionSoundEnabled: soundEnabled ?? false,
      completionSoundType: resolvedType,
      completionSoundCustomName: customName,
      completionSoundVolume: soundVolume ?? 100,
      osNotificationsEnabled: osNotifEnabled ?? false,
      notifyWhenFocused: notifyFocused ?? false,
      sessionBlockedNotificationsEnabled: blockedEnabled ?? true,
    };
  } catch (error) {
    console.error('[appSettings] Failed to load notification settings:', error);
  }

  return defaultNotificationSettings;
}

// ============================================================================
// PHASE 3: Advanced Settings
// ============================================================================

export type ReleaseChannel = 'stable' | 'alpha';
export type PreferredTerminalShell = 'auto' | 'pwsh' | 'powershell' | 'git-bash' | 'wsl' | 'cmd';

export interface AdvancedSettings {
  releaseChannel: ReleaseChannel;
  analyticsEnabled: boolean;
  extensionDevToolsEnabled: boolean;
  walkthroughsEnabled: boolean;
  walkthroughsViewedCount: number;
  walkthroughsTotalCount: number;
  // V8 heap memory limit in MB (default: 4096). Requires restart to take effect.
  maxHeapSizeMB: number;
  // Alpha feature flags - individual control over alpha features
  // Uses Record<AlphaFeatureTag, boolean> for dynamic feature registration
  alphaFeatures: Record<AlphaFeatureTag, boolean>;
  // Beta feature flags - user-visible beta features
  betaFeatures: Record<BetaFeatureTag, boolean>;
  // Whether to automatically enable all new beta features
  enableAllBetaFeatures: boolean;
  // Custom directories to add to PATH (colon-separated on Unix, semicolon-separated on Windows)
  customPathDirs: string;
  // System spellchecker (applies to all editors and text inputs)
  spellcheckEnabled: boolean;
  // Document history settings
  historyMaxAgeDays: number; // Max age in days before snapshots are cleaned up (default: 30)
  historyMaxSnapshots: number; // Max snapshots per file (default: 250)
  // Preferred terminal shell on Windows. 'auto' follows the detection priority.
  preferredTerminalShell: PreferredTerminalShell;
}

/**
 * Default advanced settings.
 */
const defaultAdvancedSettings: AdvancedSettings = {
  releaseChannel: 'stable',
  analyticsEnabled: true,
  extensionDevToolsEnabled: false,
  walkthroughsEnabled: true,
  walkthroughsViewedCount: 0,
  walkthroughsTotalCount: 0,
  maxHeapSizeMB: 4096,
  alphaFeatures: getDefaultAlphaFeatures(),
  betaFeatures: {
    blitz: false,
    codex: false,
  } as Record<BetaFeatureTag, boolean>,
  enableAllBetaFeatures: false,
  spellcheckEnabled: true,
  customPathDirs: '',
  historyMaxAgeDays: 30,
  historyMaxSnapshots: 250,
  preferredTerminalShell: 'auto',
};

/**
 * The main advanced settings atom.
 * Should be initialized from IPC on app load.
 */
export const advancedSettingsAtom = atom<AdvancedSettings>(defaultAdvancedSettings);

/**
 * Debounce timer for advanced settings persistence.
 */
let advancedPersistTimer: ReturnType<typeof setTimeout> | null = null;
// Accumulate changed keys across debounced calls. Resetting the timer
// without merging would drop the earlier call's keys (e.g. toggling
// Extension Dev Tools then any other setting within the debounce window
// would silently lose the first change).
let pendingAdvancedChangedKeys = new Set<keyof AdvancedSettings>();
let pendingAdvancedSettings: AdvancedSettings | null = null;
const ADVANCED_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist advanced settings to main process.
 * Each setting has its own IPC endpoint, so we call them individually.
 * Debounced to avoid excessive IPC calls during rapid changes.
 */
function scheduleAdvancedPersist(
  settings: AdvancedSettings,
  changedKeys: (keyof AdvancedSettings)[]
): void {
  for (const key of changedKeys) {
    pendingAdvancedChangedKeys.add(key);
  }
  pendingAdvancedSettings = settings;

  if (advancedPersistTimer) {
    clearTimeout(advancedPersistTimer);
  }
  advancedPersistTimer = setTimeout(async () => {
    advancedPersistTimer = null;
    const settingsToPersist = pendingAdvancedSettings;
    const keysToPersist = Array.from(pendingAdvancedChangedKeys);
    pendingAdvancedSettings = null;
    pendingAdvancedChangedKeys = new Set();

    if (typeof window === 'undefined' || !window.electronAPI || !settingsToPersist) return;

    for (const key of keysToPersist) {
      switch (key) {
        case 'releaseChannel':
          await window.electronAPI.invoke('release-channel:set', settingsToPersist.releaseChannel);
          break;
        case 'analyticsEnabled':
          await window.electronAPI.invoke('analytics:set-enabled', settingsToPersist.analyticsEnabled);
          break;
        case 'extensionDevToolsEnabled':
          await window.electronAPI.extensionDevTools.setEnabled(settingsToPersist.extensionDevToolsEnabled);
          break;
        case 'walkthroughsEnabled':
          await window.electronAPI.invoke('walkthroughs:set-enabled', settingsToPersist.walkthroughsEnabled);
          break;
        case 'maxHeapSizeMB':
          await window.electronAPI.invoke('app-settings:set', 'maxHeapSizeMB', settingsToPersist.maxHeapSizeMB);
          break;
        case 'alphaFeatures':
          await window.electronAPI.invoke('alpha-features:set', settingsToPersist.alphaFeatures);
          break;
        case 'betaFeatures':
          await window.electronAPI.invoke('beta-features:set', settingsToPersist.betaFeatures);
          break;
        case 'enableAllBetaFeatures':
          await window.electronAPI.invoke('beta-features:set-enable-all', settingsToPersist.enableAllBetaFeatures);
          break;
        case 'customPathDirs':
          await window.electronAPI.invoke('app-settings:set', 'customPathDirs', settingsToPersist.customPathDirs);
          break;
        case 'historyMaxAgeDays':
          await window.electronAPI.invoke('app-settings:set', 'historyMaxAgeDays', settingsToPersist.historyMaxAgeDays);
          break;
        case 'historyMaxSnapshots':
          await window.electronAPI.invoke('app-settings:set', 'historyMaxSnapshots', settingsToPersist.historyMaxSnapshots);
          break;
        case 'preferredTerminalShell':
          await window.electronAPI.invoke('app-settings:set', 'preferredTerminalShell', settingsToPersist.preferredTerminalShell);
          break;
        case 'spellcheckEnabled':
          await window.electronAPI.invoke('spellcheck:set-enabled', settingsToPersist.spellcheckEnabled);
          break;
        // walkthroughsViewedCount and walkthroughsTotalCount are read-only from main process
      }
    }
  }, ADVANCED_PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * Release channel setting.
 */
export const releaseChannelAtom = atom(
  (get) => get(advancedSettingsAtom).releaseChannel
);

/**
 * Analytics enabled setting.
 */
export const analyticsEnabledAtom = atom(
  (get) => get(advancedSettingsAtom).analyticsEnabled
);

/**
 * Extension dev tools enabled setting.
 */
export const extensionDevToolsEnabledAtom = atom(
  (get) => get(advancedSettingsAtom).extensionDevToolsEnabled
);

/**
 * Walkthroughs enabled setting.
 */
export const walkthroughsEnabledAtom = atom(
  (get) => get(advancedSettingsAtom).walkthroughsEnabled
);

/**
 * Walkthroughs viewed count (read-only from main process).
 */
export const walkthroughsViewedCountAtom = atom(
  (get) => get(advancedSettingsAtom).walkthroughsViewedCount
);

/**
 * Walkthroughs total count (read-only from main process).
 */
export const walkthroughsTotalCountAtom = atom(
  (get) => get(advancedSettingsAtom).walkthroughsTotalCount
);

/**
 * Check if a specific alpha feature is enabled by tag.
 * This is the recommended way to check feature availability.
 *
 * This is an atom family pattern: a function that returns atoms dynamically.
 * Each call with a unique tag returns the SAME cached atom instance, which
 * is critical for React/Jotai stability (avoids infinite re-renders).
 *
 * Why use a function instead of declaring atoms directly:
 * - The registry can grow over time (new features added)
 * - Type safety: AlphaFeatureTag is derived from the registry
 * - Avoids manually declaring 20+ individual atoms
 * - Each unique tag gets its own reactive atom instance
 *
 * @example
 * ```ts
 * const isSyncEnabled = useAtomValue(alphaFeatureEnabledAtom('sync'));
 * if (isSyncEnabled) {
 *   // Show sync feature
 * }
 * ```
 */
const alphaFeatureAtomCache = new Map<AlphaFeatureTag, Atom<boolean>>();

export function alphaFeatureEnabledAtom(tag: AlphaFeatureTag): Atom<boolean> {
  let cached = alphaFeatureAtomCache.get(tag);
  if (!cached) {
    cached = atom(
      (get) => get(advancedSettingsAtom).alphaFeatures[tag] ?? false
    );
    alphaFeatureAtomCache.set(tag, cached);
  }
  return cached;
}

/**
 * Check if a specific beta feature is enabled by tag.
 * Same atom family pattern as alpha features.
 */
const betaFeatureAtomCache = new Map<BetaFeatureTag, Atom<boolean>>();

export function betaFeatureEnabledAtom(tag: BetaFeatureTag): Atom<boolean> {
  let cached = betaFeatureAtomCache.get(tag);
  if (!cached) {
    cached = atom(
      (get) => get(advancedSettingsAtom).betaFeatures[tag] ?? false
    );
    betaFeatureAtomCache.set(tag, cached);
  }
  return cached;
}

/**
 * V8 heap memory limit in MB.
 */
export const maxHeapSizeMBAtom = atom(
  (get) => get(advancedSettingsAtom).maxHeapSizeMB
);

/**
 * System spellchecker enabled.
 */
export const spellcheckEnabledAtom = atom(
  (get) => get(advancedSettingsAtom).spellcheckEnabled
);

/**
 * Custom PATH directories.
 */
export const customPathDirsAtom = atom(
  (get) => get(advancedSettingsAtom).customPathDirs
);

// === Setter atoms ===

/**
 * Set advanced settings (partial update).
 * Merges with existing settings and triggers persist for changed keys only.
 */
export const setAdvancedSettingsAtom = atom(
  null,
  (get, set, updates: Partial<AdvancedSettings>) => {
    const current = get(advancedSettingsAtom);
    const newSettings = { ...current, ...updates };
    set(advancedSettingsAtom, newSettings);

    // Determine which keys changed for targeted persistence
    const changedKeys = (Object.keys(updates) as (keyof AdvancedSettings)[]).filter(
      (key) => updates[key] !== current[key]
    );
    if (changedKeys.length > 0) {
      scheduleAdvancedPersist(newSettings, changedKeys);
    }
  }
);

/**
 * Reset walkthroughs - special action that calls IPC and updates atom.
 */
export const resetWalkthroughsAtom = atom(null, async (get, set) => {
  if (typeof window !== 'undefined' && window.electronAPI) {
    await window.electronAPI.invoke('walkthroughs:reset');
  }
  const current = get(advancedSettingsAtom);
  set(advancedSettingsAtom, { ...current, walkthroughsViewedCount: 0 });
});

/**
 * Initialize advanced settings from IPC.
 * Call this once at app startup.
 */
export async function initAdvancedSettings(): Promise<AdvancedSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return defaultAdvancedSettings;
  }

  try {
    const [channel, analyticsEnabled, extensionDevToolsEnabled, walkthroughState, maxHeapSizeMB, alphaFeatures, betaFeatures, enableAllBetaFeatures, customPathDirs, spellcheckEnabled, historyMaxAgeDays, historyMaxSnapshots, preferredTerminalShell] =
      await Promise.all([
        window.electronAPI.invoke('release-channel:get'),
        window.electronAPI.invoke('analytics:is-enabled'),
        window.electronAPI.extensionDevTools.isEnabled(),
        window.electronAPI.invoke('walkthroughs:get-state'),
        window.electronAPI.invoke('app-settings:get', 'maxHeapSizeMB'),
        window.electronAPI.invoke('alpha-features:get'),
        window.electronAPI.invoke('beta-features:get'),
        window.electronAPI.invoke('beta-features:get-enable-all'),
        window.electronAPI.invoke('app-settings:get', 'customPathDirs'),
        window.electronAPI.invoke('app-settings:get', 'spellcheckEnabled'),
        window.electronAPI.invoke('app-settings:get', 'historyMaxAgeDays'),
        window.electronAPI.invoke('app-settings:get', 'historyMaxSnapshots'),
        window.electronAPI.invoke('app-settings:get', 'preferredTerminalShell'),
      ]);

    // Calculate viewed count (completed + dismissed)
    const walkthroughsViewedCount =
      (walkthroughState?.completed?.length ?? 0) + (walkthroughState?.dismissed?.length ?? 0);
    const walkthroughsTotalCount = walkthroughState?.totalCount ?? 0;

    return {
      releaseChannel: channel ?? 'stable',
      analyticsEnabled: analyticsEnabled ?? true,
      extensionDevToolsEnabled: extensionDevToolsEnabled ?? false,
      walkthroughsEnabled: walkthroughState?.enabled ?? true,
      walkthroughsViewedCount,
      walkthroughsTotalCount,
      maxHeapSizeMB: maxHeapSizeMB ?? 4096,
      alphaFeatures: { ...defaultAdvancedSettings.alphaFeatures, ...(alphaFeatures ?? {}) },
      betaFeatures: betaFeatures ?? defaultAdvancedSettings.betaFeatures,
      enableAllBetaFeatures: enableAllBetaFeatures ?? false,
      spellcheckEnabled: spellcheckEnabled ?? true,
      customPathDirs: customPathDirs ?? '',
      historyMaxAgeDays: historyMaxAgeDays ?? 30,
      historyMaxSnapshots: historyMaxSnapshots ?? 250,
      preferredTerminalShell: preferredTerminalShell ?? 'auto',
    };
  } catch (error) {
    console.error('[appSettings] Failed to load advanced settings:', error);
  }

  return defaultAdvancedSettings;
}

// ============================================================================
// PHASE 4: Sync Settings
// ============================================================================

export interface SyncConfig {
  enabled: boolean;
  serverUrl: string;
  enabledProjects?: string[]; // workspace paths that are enabled for session sync
  docSyncEnabledProjects?: string[]; // workspace paths that are enabled for document sync (alpha only)
  environment?: 'development' | 'production'; // dev only: override environment
  idleTimeoutMinutes?: number; // minutes before user is considered idle (default: 5)
  personalOrgId?: string; // persisted sync identity -- which org to use for sync room IDs
  personalUserId?: string;
  preventSleepWhenSyncing?: boolean; // DEPRECATED: migrated to preventSleepMode
  preventSleepMode?: 'off' | 'always' | 'pluggedIn'; // prevent system sleep while sync is active
}

/**
 * Default sync settings.
 * All optional fields have explicit defaults to handle old persisted data.
 */
const defaultSyncConfig: SyncConfig = {
  enabled: false,
  serverUrl: '',
  enabledProjects: [],
  docSyncEnabledProjects: [],
  environment: undefined, // Intentionally undefined (only set in dev)
  idleTimeoutMinutes: 5,
};

/**
 * The main sync config atom.
 * Should be initialized from IPC on app load.
 */
export const syncConfigAtom = atom<SyncConfig>(defaultSyncConfig);

/**
 * Debounce timer for sync config persistence.
 */
let syncPersistTimer: ReturnType<typeof setTimeout> | null = null;
const SYNC_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist sync config to main process.
 * Debounced to avoid excessive IPC calls during rapid changes.
 */
function scheduleSyncPersist(config: SyncConfig): void {
  if (syncPersistTimer) {
    clearTimeout(syncPersistTimer);
  }
  syncPersistTimer = setTimeout(async () => {
    syncPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      // Save null if disabled to clear the config
      await window.electronAPI.invoke('sync:set-config', config.enabled ? config : null);
    }
  }, SYNC_PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * Sync enabled state.
 */
export const syncEnabledAtom = atom((get) => get(syncConfigAtom).enabled);

/**
 * Sync server URL.
 */
export const syncServerUrlAtom = atom((get) => get(syncConfigAtom).serverUrl);

/**
 * Enabled projects for sync.
 */
export const syncEnabledProjectsAtom = atom((get) => get(syncConfigAtom).enabledProjects ?? []);

/**
 * Idle timeout in minutes (default 5).
 */
export const syncIdleTimeoutMinutesAtom = atom((get) => get(syncConfigAtom).idleTimeoutMinutes ?? 5);

// === Setter atoms ===

/**
 * Set sync config (partial update).
 * Merges with existing config and triggers persist.
 */
export const setSyncConfigAtom = atom(
  null,
  (get, set, updates: Partial<SyncConfig>) => {
    const current = get(syncConfigAtom);
    const newConfig = { ...current, ...updates };
    set(syncConfigAtom, newConfig);
    scheduleSyncPersist(newConfig);
  }
);

/**
 * Initialize sync config from IPC.
 * Call this once at app startup.
 */
export async function initSyncConfig(): Promise<SyncConfig> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return defaultSyncConfig;
  }

  try {
    const config = await window.electronAPI.invoke('sync:get-config');
    if (config) {
      // Spread persisted config over defaults so new fields are never silently dropped
      return { ...defaultSyncConfig, ...config };
    }
  } catch (error) {
    console.error('[appSettings] Failed to load sync config:', error);
  }

  return defaultSyncConfig;
}

// ============================================================================
// PHASE 5: AI Debug Settings
// ============================================================================

export interface AIDebugSettings {
  showToolCalls: boolean;
  chatShowToolCalls: boolean;
  aiDebugLogging: boolean;
  showPromptAdditions: boolean;
}

/**
 * Default AI debug settings.
 */
const defaultAIDebugSettings: AIDebugSettings = {
  showToolCalls: false,
  chatShowToolCalls: true,
  aiDebugLogging: false,
  showPromptAdditions: false,
};

/**
 * The main AI debug settings atom.
 * These are dev-only settings for debugging AI interactions.
 * Should be initialized from IPC on app load.
 */
export const aiDebugSettingsAtom = atom<AIDebugSettings>(defaultAIDebugSettings);

/**
 * Debounce timer for AI debug settings persistence.
 */
let aiDebugPersistTimer: ReturnType<typeof setTimeout> | null = null;
const AI_DEBUG_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist AI debug settings to main process.
 * These are saved as part of AI settings.
 */
function scheduleAIDebugPersist(settings: AIDebugSettings): void {
  if (aiDebugPersistTimer) {
    clearTimeout(aiDebugPersistTimer);
  }
  aiDebugPersistTimer = setTimeout(async () => {
    aiDebugPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      // Send only the changed fields -- ai:saveSettings handles partial updates
      try {
        await window.electronAPI.aiSaveSettings({
          showToolCalls: settings.showToolCalls,
          chatShowToolCalls: settings.chatShowToolCalls,
          aiDebugLogging: settings.aiDebugLogging,
          showPromptAdditions: settings.showPromptAdditions,
        });
      } catch (error) {
        console.error('[appSettings] Failed to save AI debug settings:', error);
      }
    }
  }, AI_DEBUG_PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * Show tool calls setting (developer-mode only - the existing dev toggle).
 */
export const showToolCallsAtom = atom((get) => get(aiDebugSettingsAtom).showToolCalls);

/**
 * User-facing chat-view tool-call visibility (default true).
 * Independent of the dev-only `showToolCallsAtom` above. Reporter on #118
 * who manually sets `chatShowToolCalls: false` in ai-settings.json sees
 * tool rows hidden; default-true preserves UX for everyone else.
 */
export const chatShowToolCallsAtom = atom((get) => get(aiDebugSettingsAtom).chatShowToolCalls);

/**
 * AI debug logging setting.
 */
export const aiDebugLoggingAtom = atom((get) => get(aiDebugSettingsAtom).aiDebugLogging);

/**
 * Show prompt additions setting.
 */
export const showPromptAdditionsAtom = atom((get) => get(aiDebugSettingsAtom).showPromptAdditions);

// === Setter atoms ===

/**
 * Set AI debug settings (partial update).
 * Merges with existing settings and triggers persist.
 */
export const setAIDebugSettingsAtom = atom(
  null,
  (get, set, updates: Partial<AIDebugSettings>) => {
    const current = get(aiDebugSettingsAtom);
    const newSettings = { ...current, ...updates };
    set(aiDebugSettingsAtom, newSettings);
    scheduleAIDebugPersist(newSettings);
  }
);

/**
 * Initialize AI debug settings from IPC.
 * Call this once at app startup.
 */
export async function initAIDebugSettings(): Promise<AIDebugSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return defaultAIDebugSettings;
  }

  try {
    const settings = await window.electronAPI.aiGetSettings();
    return {
      showToolCalls: settings?.showToolCalls ?? false,
      chatShowToolCalls: settings?.chatShowToolCalls ?? true,
      aiDebugLogging: settings?.aiDebugLogging ?? false,
      showPromptAdditions: settings?.showPromptAdditions ?? false,
    };
  } catch (error) {
    console.error('[appSettings] Failed to load AI debug settings:', error);
  }

  return defaultAIDebugSettings;
}

// ============================================================================
// PHASE 5a: Agent Mode Settings (Default Model)
// ============================================================================

export interface AgentModeSettings {
  /** The last model selected by the user in agent mode, used as default for new sessions */
  defaultModel: string;
  /** The effort level for Opus 4.6 adaptive reasoning (low/medium/high/max) */
  defaultEffortLevel: EffortLevel;
}

/**
 * Default agent mode settings.
 */
const defaultAgentModeSettings: AgentModeSettings = {
  defaultModel: 'claude-code:opus-1m',
  defaultEffortLevel: DEFAULT_EFFORT_LEVEL,
};

/**
 * The main agent mode settings atom.
 * Should be initialized from IPC on app load.
 */
export const agentModeSettingsAtom = atom<AgentModeSettings>(defaultAgentModeSettings);

/**
 * Debounce timer for agent mode settings persistence.
 */
let agentModePersistTimer: ReturnType<typeof setTimeout> | null = null;
const AGENT_MODE_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist agent mode settings to main process.
 */
function scheduleAgentModePersist(settings: AgentModeSettings): void {
  if (agentModePersistTimer) {
    clearTimeout(agentModePersistTimer);
  }
  agentModePersistTimer = setTimeout(async () => {
    agentModePersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      await window.electronAPI.invoke('settings:set-default-ai-model', settings.defaultModel);
      await window.electronAPI.invoke('settings:set-default-effort-level', settings.defaultEffortLevel);
    }
  }, AGENT_MODE_PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * Default model for new agent sessions.
 */
export const defaultAgentModelAtom = atom((get) => get(agentModeSettingsAtom).defaultModel);

/**
 * Default effort level for Opus 4.6 adaptive reasoning.
 */
export const defaultEffortLevelAtom = atom((get) => get(agentModeSettingsAtom).defaultEffortLevel);

// === Setter atoms ===

/**
 * Set agent mode settings (partial update).
 * Merges with existing settings and triggers persist.
 */
export const setAgentModeSettingsAtom = atom(
  null,
  (get, set, updates: Partial<AgentModeSettings>) => {
    const current = get(agentModeSettingsAtom);
    const newSettings = { ...current, ...updates };
    set(agentModeSettingsAtom, newSettings);
    scheduleAgentModePersist(newSettings);
  }
);

/**
 * Initialize agent mode settings from IPC.
 * Call this once at app startup.
 */
export async function initAgentModeSettings(): Promise<AgentModeSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    // console.log('[appSettings] initAgentModeSettings: No window/electronAPI, using defaults');
    return defaultAgentModeSettings;
  }

  try {
    const defaultModel = await window.electronAPI.invoke('settings:get-default-ai-model');
    const defaultEffortLevel = await window.electronAPI.invoke('settings:get-default-effort-level');
    const result = {
      defaultModel: defaultModel ?? defaultAgentModeSettings.defaultModel,
      defaultEffortLevel: parseEffortLevel(defaultEffortLevel),
    };
    return result;
  } catch (error) {
    console.error('[appSettings] Failed to load agent mode settings:', error);
  }

  // console.log('[appSettings] initAgentModeSettings: Using defaults');
  return defaultAgentModeSettings;
}

// ============================================================================
// PHASE 5b: AI Provider Settings
// ============================================================================

/**
 * Provider configuration stored in AI settings.
 * This mirrors the ProviderConfig interface in SettingsView but is the source of truth.
 */
export interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
  testStatus?: 'idle' | 'testing' | 'success' | 'error';
  testMessage?: string;
  installed?: boolean;
  version?: string;
  updateAvailable?: boolean;
  installStatus?: 'not-installed' | 'installing' | 'installed' | 'error';
  authMethod?: string;
}

/**
 * Model definition for available models.
 */
export interface AIModel {
  id: string;
  name: string;
  provider: string;
}

/**
 * Full AI provider settings structure.
 */
export interface AIProviderSettings {
  providers: Record<string, ProviderConfig>;
  apiKeys: Record<string, string>;
  availableModels: Record<string, AIModel[]>;
}

/**
 * Default provider configurations.
 */
const defaultProviders: Record<string, ProviderConfig> = {
  claude: { enabled: false, testStatus: 'idle' },
  'claude-code': { enabled: true, testStatus: 'idle', installStatus: 'not-installed' },
  openai: { enabled: false, testStatus: 'idle' },
  'openai-codex': { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  'openai-codex-acp': { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  opencode: { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  'copilot-cli': { enabled: false, testStatus: 'idle', installStatus: 'not-installed' },
  lmstudio: { enabled: false, baseUrl: 'http://127.0.0.1:8234', testStatus: 'idle' },
};

/**
 * Default API keys.
 */
const defaultApiKeys: Record<string, string> = {
  anthropic: '',
  'claude-code': '',
  openai: '',
  'openai-codex': '',
  lmstudio_url: 'http://127.0.0.1:8234',
};

/**
 * Default AI provider settings.
 */
const defaultAIProviderSettings: AIProviderSettings = {
  providers: defaultProviders,
  apiKeys: defaultApiKeys,
  availableModels: {},
};

/**
 * The main AI provider settings atom.
 * Should be initialized from IPC on app load.
 */
export const aiProviderSettingsAtom = atom<AIProviderSettings>(defaultAIProviderSettings);

/**
 * Debounce timer for AI provider settings persistence.
 */
let aiProviderPersistTimer: ReturnType<typeof setTimeout> | null = null;
const AI_PROVIDER_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persists are gated on successful init (see initAIProviderSettings). Until the
 * atom has been hydrated from real IPC data, every flush is dropped so a stale
 * default-valued atom (e.g. from a transient IPC failure at startup) can never
 * overwrite the real stored settings on disk.
 */
let aiProviderInitComplete = false;

/**
 * Accumulators for pending changes. Live at module scope so a second scheduled
 * call within the debounce window can't drop earlier calls' keys -- see
 * feedback_debounce_clobbered_keys.md.
 */
const pendingProviderIds = new Set<string>();
const pendingApiKeyNames = new Set<string>();

/**
 * Remove the `models` field from openai-codex provider config before persisting.
 * Codex uses dynamic model discovery from the API instead of user-configured model selections.
 */
function sanitizeProvidersForPersistence(providers: Record<string, ProviderConfig>): Record<string, ProviderConfig> {
  return normalizeCodexProviderConfig(
    stripTransientProviderFields(providers)
  );
}

/**
 * Schedule a persist of only the changed provider / apiKey slices.
 *
 * Callers pass the providerIds and apiKeyNames they touched. The flush reads
 * the latest atom snapshot and sends only those slices, so unrelated keys can
 * never be clobbered by a stale full-object spread.
 */
function scheduleAIProviderPersist(changes: { providerIds?: Iterable<string>; apiKeyNames?: Iterable<string> }): void {
  if (changes.providerIds) {
    for (const id of changes.providerIds) pendingProviderIds.add(id);
  }
  if (changes.apiKeyNames) {
    for (const name of changes.apiKeyNames) pendingApiKeyNames.add(name);
  }

  if (pendingProviderIds.size === 0 && pendingApiKeyNames.size === 0) {
    return;
  }

  if (aiProviderPersistTimer) {
    clearTimeout(aiProviderPersistTimer);
  }
  aiProviderPersistTimer = setTimeout(flushAIProviderPersist, AI_PROVIDER_PERSIST_DEBOUNCE_MS);
}

async function flushAIProviderPersist(): Promise<void> {
  aiProviderPersistTimer = null;

  if (!aiProviderInitComplete) {
    console.warn('[appSettings] Dropping AI provider persist: init not complete', {
      providerIds: Array.from(pendingProviderIds),
      apiKeyNames: Array.from(pendingApiKeyNames),
    });
    pendingProviderIds.clear();
    pendingApiKeyNames.clear();
    return;
  }

  if (typeof window === 'undefined' || !window.electronAPI) {
    pendingProviderIds.clear();
    pendingApiKeyNames.clear();
    return;
  }

  const snapshot = store.get(aiProviderSettingsAtom);

  const providerIdsToSend = Array.from(pendingProviderIds);
  const apiKeyNamesToSend = Array.from(pendingApiKeyNames);
  pendingProviderIds.clear();
  pendingApiKeyNames.clear();

  const payload: { providerSettings?: Record<string, ProviderConfig>; apiKeys?: Record<string, string> } = {};

  if (providerIdsToSend.length > 0) {
    const partialProviders: Record<string, ProviderConfig> = {};
    for (const id of providerIdsToSend) {
      const config = snapshot.providers[id];
      if (config !== undefined) {
        partialProviders[id] = config;
      }
    }
    payload.providerSettings = sanitizeProvidersForPersistence(partialProviders);
  }

  if (apiKeyNamesToSend.length > 0) {
    const partialApiKeys: Record<string, string> = {};
    for (const name of apiKeyNamesToSend) {
      const value = snapshot.apiKeys[name];
      if (value !== undefined) {
        partialApiKeys[name] = value;
      }
    }
    payload.apiKeys = partialApiKeys;
  }

  try {
    await window.electronAPI.aiSaveSettings(payload);
  } catch (error) {
    console.error('[appSettings] Failed to save AI provider settings:', error);
  }
}

/**
 * Immediately flush any pending AI provider settings persist, bypassing the
 * 500ms debounce. Callers that need the main process to see the latest
 * provider / apiKey changes before making an IPC call (e.g. testing a
 * connection) should await this first.
 */
export async function flushPendingAIProviderPersist(): Promise<void> {
  if (aiProviderPersistTimer) {
    clearTimeout(aiProviderPersistTimer);
    aiProviderPersistTimer = null;
  }
  if (pendingProviderIds.size === 0 && pendingApiKeyNames.size === 0) {
    return;
  }
  await flushAIProviderPersist();
}

// === Derived read-only atoms (slices) ===

/**
 * Provider configurations.
 */
export const providersAtom = atom((get) => get(aiProviderSettingsAtom).providers);

/**
 * API keys.
 */
export const apiKeysAtom = atom((get) => get(aiProviderSettingsAtom).apiKeys);

/**
 * Available models per provider.
 */
export const availableModelsAtom = atom((get) => get(aiProviderSettingsAtom).availableModels);

/**
 * Get enabled providers.
 */
export const enabledProvidersAtom = atom((get) => {
  const providers = get(aiProviderSettingsAtom).providers;
  return Object.entries(providers)
    .filter(([_, config]) => config.enabled)
    .map(([id]) => id);
});

/**
 * Get a specific provider's config.
 */
export const getProviderConfigAtom = (providerId: string) =>
  atom((get) => get(aiProviderSettingsAtom).providers[providerId]);

/**
 * Get a specific API key.
 */
export const getApiKeyAtom = (keyName: string) =>
  atom((get) => get(aiProviderSettingsAtom).apiKeys[keyName] ?? '');

// === Setter atoms ===

/**
 * Set AI provider settings (partial update).
 * Merges with existing settings and schedules persistence of only the changed slices.
 * Updates to `availableModels` are NOT persisted (they are fetched from APIs).
 */
export const setAIProviderSettingsAtom = atom(
  null,
  (get, set, updates: Partial<AIProviderSettings>) => {
    const current = get(aiProviderSettingsAtom);
    const newSettings = {
      ...current,
      ...updates,
      providers: updates.providers ? { ...current.providers, ...updates.providers } : current.providers,
      apiKeys: updates.apiKeys ? { ...current.apiKeys, ...updates.apiKeys } : current.apiKeys,
      availableModels: updates.availableModels
        ? { ...current.availableModels, ...updates.availableModels }
        : current.availableModels,
    };
    set(aiProviderSettingsAtom, newSettings);
    scheduleAIProviderPersist({
      providerIds: updates.providers ? Object.keys(updates.providers) : undefined,
      apiKeyNames: updates.apiKeys ? Object.keys(updates.apiKeys) : undefined,
    });
  }
);

/**
 * Update a single provider's config.
 */
export const setProviderConfigAtom = atom(
  null,
  (get, set, { providerId, config }: { providerId: string; config: Partial<ProviderConfig> }) => {
    const current = get(aiProviderSettingsAtom);
    const newSettings = {
      ...current,
      providers: {
        ...current.providers,
        [providerId]: { ...current.providers[providerId], ...config },
      },
    };
    set(aiProviderSettingsAtom, newSettings);
    scheduleAIProviderPersist({ providerIds: [providerId] });
  }
);

/**
 * Update a single API key.
 */
export const setApiKeyAtom = atom(
  null,
  (get, set, { keyName, value }: { keyName: string; value: string }) => {
    const current = get(aiProviderSettingsAtom);
    const newSettings = {
      ...current,
      apiKeys: {
        ...current.apiKeys,
        [keyName]: value,
      },
    };
    set(aiProviderSettingsAtom, newSettings);
    scheduleAIProviderPersist({ apiKeyNames: [keyName] });
  }
);

/**
 * Update available models for a provider (no persistence - this is cached data).
 */
export const setAvailableModelsAtom = atom(
  null,
  (get, set, { providerId, models }: { providerId: string; models: AIModel[] }) => {
    const current = get(aiProviderSettingsAtom);
    set(aiProviderSettingsAtom, {
      ...current,
      availableModels: {
        ...current.availableModels,
        [providerId]: models,
      },
    });
    // Note: Available models are NOT persisted - they're fetched from APIs
  }
);

/**
 * Initialize AI provider settings from IPC.
 * Call this once at app startup.
 *
 * Throws on failure rather than returning defaults. If this silently returned
 * defaults, the atom would hold `codex.enabled=false` etc., and the next
 * setter call would persist that stale state -- silently flipping real saved
 * settings off (NIM-801). The persist scheduler is gated on the success of
 * this function via `aiProviderInitComplete`.
 */
export async function initAIProviderSettings(): Promise<AIProviderSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    throw new Error('initAIProviderSettings: electronAPI unavailable');
  }

  const settings = await window.electronAPI.aiGetSettings();
  const providers = { ...defaultProviders };
  const apiKeys = { ...defaultApiKeys };

  // Merge loaded provider settings
  if (settings?.providerSettings) {
    Object.entries(settings.providerSettings).forEach(([key, value]: [string, any]) => {
      if (providers[key]) {
        providers[key] = { ...providers[key], ...value };
      }
    });
  }

  const sanitizedProviders = sanitizeProvidersForPersistence(providers);

  // Merge loaded API keys
  if (settings?.apiKeys) {
    Object.assign(apiKeys, settings.apiKeys);
  }

  aiProviderInitComplete = true;

  return {
    providers: sanitizedProviders,
    apiKeys,
    availableModels: {}, // Models are fetched separately, not persisted
  };
}

// ============================================================================
// PHASE 6: Workspace Settings (Atom Families)
// ============================================================================

/**
 * Provider override for a single provider in a workspace.
 */
export interface ProviderOverride {
  enabled?: boolean;
  models?: string[];
  defaultModel?: string;
  apiKey?: string;
}

/**
 * AI provider overrides for a workspace.
 */
export interface AIProviderOverrides {
  defaultProvider?: string;
  customClaudeCodePath?: string;
  providers?: Record<string, ProviderOverride>;
}

/**
 * Workspace AI settings state including loading status.
 */
export interface WorkspaceAISettingsState {
  overrides: AIProviderOverrides;
  loading: boolean;
  error: string | null;
}

/**
 * Default workspace AI settings state.
 */
const defaultWorkspaceAISettingsState: WorkspaceAISettingsState = {
  overrides: {},
  loading: true,
  error: null,
};

/**
 * Cache for workspace AI settings atoms.
 * Using a Map for O(1) lookup by workspace path.
 */
const workspaceAISettingsCache = new Map<string, ReturnType<typeof atom<WorkspaceAISettingsState>>>();

/**
 * Atom family for workspace AI settings.
 * Each workspace has its own atom storing provider overrides.
 *
 * Usage:
 * ```ts
 * const settingsAtom = workspaceAISettingsAtomFamily(workspacePath);
 * const [settings, setSettings] = useAtom(settingsAtom);
 * ```
 */
export function workspaceAISettingsAtomFamily(workspacePath: string) {
  if (!workspaceAISettingsCache.has(workspacePath)) {
    workspaceAISettingsCache.set(workspacePath, atom<WorkspaceAISettingsState>(defaultWorkspaceAISettingsState));
  }
  return workspaceAISettingsCache.get(workspacePath)!;
}

/**
 * Load workspace AI settings from IPC.
 * Call this when a workspace is opened or when settings need to be refreshed.
 */
export async function loadWorkspaceAISettings(workspacePath: string): Promise<WorkspaceAISettingsState> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return { ...defaultWorkspaceAISettingsState, loading: false };
  }

  try {
    const result = await window.electronAPI.invoke('ai:getProjectSettings', workspacePath);
    if (result.success && result.overrides) {
      return {
        overrides: result.overrides,
        loading: false,
        error: null,
      };
    }
    return { overrides: {}, loading: false, error: null };
  } catch (error) {
    console.error('[appSettings] Failed to load workspace AI settings:', error);
    return {
      overrides: {},
      loading: false,
      error: error instanceof Error ? error.message : 'Failed to load workspace AI settings',
    };
  }
}

/**
 * Save workspace AI settings to IPC.
 */
export async function saveWorkspaceAISettings(workspacePath: string, overrides: AIProviderOverrides): Promise<void> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return;
  }

  try {
    await window.electronAPI.invoke('ai:saveProjectSettings', workspacePath, overrides);
  } catch (error) {
    console.error('[appSettings] Failed to save workspace AI settings:', error);
    throw error;
  }
}

/**
 * Setter atom for workspace AI settings.
 * Updates the atom and persists to IPC.
 */
export function setWorkspaceAISettingsAtomFamily(workspacePath: string) {
  return atom(
    null,
    async (get, set, updates: Partial<AIProviderOverrides>) => {
      const settingsAtom = workspaceAISettingsAtomFamily(workspacePath);
      const current = get(settingsAtom);
      const newOverrides = {
        ...current.overrides,
        ...updates,
        providers: updates.providers
          ? { ...current.overrides.providers, ...updates.providers }
          : current.overrides.providers,
      };
      set(settingsAtom, { ...current, overrides: newOverrides });
      await saveWorkspaceAISettings(workspacePath, newOverrides);
    }
  );
}

// ============================================================================
// Workspace Permissions (Agent Permissions)
// ============================================================================

/**
 * Pattern rule for allowed/denied commands.
 */
export interface PatternRule {
  pattern: string;
  displayName: string;
  addedAt: number;
}

/**
 * Additional directory that the agent can access.
 */
export interface AdditionalDirectory {
  path: string;
  addedAt: number;
}

/**
 * Allowed URL pattern for web fetch.
 */
export interface AllowedUrlPattern {
  pattern: string;
  description: string;
  addedAt: number;
}

/**
 * Permission mode for a workspace.
 */
export type PermissionMode = 'ask' | 'allow-all' | 'bypass-all';

/**
 * Full permissions state for a workspace.
 */
export interface WorkspacePermissionsState {
  trustedAt?: number;
  permissionMode: PermissionMode | null;
  allowedPatterns: PatternRule[];
  additionalDirectories: AdditionalDirectory[];
  allowedUrlPatterns: AllowedUrlPattern[];
  loading: boolean;
  error: string | null;
}

/**
 * Default workspace permissions state.
 */
const defaultWorkspacePermissionsState: WorkspacePermissionsState = {
  permissionMode: null,
  allowedPatterns: [],
  additionalDirectories: [],
  allowedUrlPatterns: [],
  loading: true,
  error: null,
};

/**
 * Cache for workspace permissions atoms.
 */
const workspacePermissionsCache = new Map<string, ReturnType<typeof atom<WorkspacePermissionsState>>>();

/**
 * Atom family for workspace permissions.
 * Each workspace has its own atom storing permission settings.
 *
 * Usage:
 * ```ts
 * const permissionsAtom = workspacePermissionsAtomFamily(workspacePath);
 * const [permissions] = useAtom(permissionsAtom);
 * ```
 */
export function workspacePermissionsAtomFamily(workspacePath: string) {
  if (!workspacePermissionsCache.has(workspacePath)) {
    workspacePermissionsCache.set(workspacePath, atom<WorkspacePermissionsState>(defaultWorkspacePermissionsState));
  }
  return workspacePermissionsCache.get(workspacePath)!;
}

/**
 * Load workspace permissions from IPC.
 * Call this when a workspace is opened or when permissions change.
 */
export async function loadWorkspacePermissions(workspacePath: string): Promise<WorkspacePermissionsState> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return { ...defaultWorkspacePermissionsState, loading: false };
  }

  try {
    const result = await window.electronAPI.invoke('permissions:getWorkspacePermissions', workspacePath);
    if (result) {
      return {
        trustedAt: result.trustedAt,
        permissionMode: result.permissionMode,
        allowedPatterns: result.allowedPatterns || [],
        additionalDirectories: result.additionalDirectories || [],
        allowedUrlPatterns: result.allowedUrlPatterns || [],
        loading: false,
        error: null,
      };
    }
    return { ...defaultWorkspacePermissionsState, loading: false };
  } catch (error) {
    console.error('[appSettings] Failed to load workspace permissions:', error);
    return {
      ...defaultWorkspacePermissionsState,
      loading: false,
      error: error instanceof Error ? error.message : 'Failed to load workspace permissions',
    };
  }
}

/**
 * Refresh action atom for workspace permissions.
 * Use this to reload permissions after changes.
 */
export function refreshWorkspacePermissionsAtomFamily(workspacePath: string) {
  return atom(null, async (get, set) => {
    const permissionsAtom = workspacePermissionsAtomFamily(workspacePath);
    set(permissionsAtom, { ...get(permissionsAtom), loading: true });
    const newState = await loadWorkspacePermissions(workspacePath);
    set(permissionsAtom, newState);
  });
}

// ============================================================================
// PHASE 7: Developer Feature Settings
// ============================================================================

export interface DeveloperFeatureSettings {
  /** Whether developer mode is enabled globally */
  developerMode: boolean;
  /** Individual feature toggles (only checked when developerMode is true) */
  developerFeatures: Record<DeveloperFeatureTag, boolean>;
}

/**
 * Default developer feature settings.
 * All features are enabled by default when developer mode is on.
 */
const defaultDeveloperFeatureSettings: DeveloperFeatureSettings = {
  developerMode: false,
  developerFeatures: getDefaultDeveloperFeatures(),
};

/**
 * The main developer feature settings atom.
 * Should be initialized from IPC on app load.
 */
export const developerFeatureSettingsAtom = atom<DeveloperFeatureSettings>(defaultDeveloperFeatureSettings);

/**
 * Debounce timer for developer feature settings persistence.
 */
let developerFeaturePersistTimer: ReturnType<typeof setTimeout> | null = null;
// Accumulate changed keys so a second call inside the debounce window
// doesn't drop keys queued by the first (same pattern as advanced settings).
let pendingDeveloperFeatureChangedKeys = new Set<keyof DeveloperFeatureSettings>();
let pendingDeveloperFeatureSettings: DeveloperFeatureSettings | null = null;
const DEVELOPER_FEATURE_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist developer feature settings to main process.
 * Each setting has its own IPC endpoint, so we call them individually.
 */
function scheduleDeveloperFeaturePersist(
  settings: DeveloperFeatureSettings,
  changedKeys: (keyof DeveloperFeatureSettings)[]
): void {
  for (const key of changedKeys) {
    pendingDeveloperFeatureChangedKeys.add(key);
  }
  pendingDeveloperFeatureSettings = settings;

  if (developerFeaturePersistTimer) {
    clearTimeout(developerFeaturePersistTimer);
  }
  developerFeaturePersistTimer = setTimeout(async () => {
    developerFeaturePersistTimer = null;
    const settingsToPersist = pendingDeveloperFeatureSettings;
    const keysToPersist = Array.from(pendingDeveloperFeatureChangedKeys);
    pendingDeveloperFeatureSettings = null;
    pendingDeveloperFeatureChangedKeys = new Set();

    if (typeof window === 'undefined' || !window.electronAPI || !settingsToPersist) return;

    for (const key of keysToPersist) {
      switch (key) {
        case 'developerMode':
          await window.electronAPI.invoke('developer-mode:set', settingsToPersist.developerMode);
          break;
        case 'developerFeatures':
          await window.electronAPI.invoke('developer-features:set', settingsToPersist.developerFeatures);
          break;
      }
    }
  }, DEVELOPER_FEATURE_PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * Developer mode enabled state.
 */
export const developerModeAtom = atom(
  (get) => get(developerFeatureSettingsAtom).developerMode
);

/**
 * All developer features configuration.
 */
export const developerFeaturesAtom = atom(
  (get) => get(developerFeatureSettingsAtom).developerFeatures
);

/**
 * Check if a specific developer feature is available.
 * Feature is available if developer mode is enabled AND the specific feature is enabled.
 *
 * This is an atom family pattern: a function that returns atoms dynamically.
 * Each call with a unique tag returns the SAME cached atom instance.
 *
 * @example
 * ```ts
 * const isWorktreesAvailable = useAtomValue(developerFeatureAvailableAtom('worktrees'));
 * if (isWorktreesAvailable) {
 *   // Show worktree feature
 * }
 * ```
 */
const developerFeatureAtomCache = new Map<DeveloperFeatureTag, Atom<boolean>>();

export function developerFeatureAvailableAtom(tag: DeveloperFeatureTag): Atom<boolean> {
  let cached = developerFeatureAtomCache.get(tag);
  if (!cached) {
    cached = atom(
      (get) => {
        const settings = get(developerFeatureSettingsAtom);
        return settings.developerMode && (settings.developerFeatures[tag] ?? false);
      }
    );
    developerFeatureAtomCache.set(tag, cached);
  }
  return cached;
}

/**
 * Developer feature: Worktrees available (convenience atom)
 */
export const worktreesFeatureAvailableAtom = developerFeatureAvailableAtom('worktrees');

/**
 * Developer feature: Terminal available (convenience atom)
 */
export const terminalFeatureAvailableAtom = developerFeatureAvailableAtom('terminal');

// === Setter atoms ===

/**
 * Set developer feature settings (partial update).
 * Merges with existing settings and triggers persist for changed keys only.
 */
export const setDeveloperFeatureSettingsAtom = atom(
  null,
  (get, set, updates: Partial<DeveloperFeatureSettings>) => {
    const current = get(developerFeatureSettingsAtom);
    const newSettings = { ...current, ...updates };
    set(developerFeatureSettingsAtom, newSettings);

    // Determine which keys changed for targeted persistence
    const changedKeys = (Object.keys(updates) as (keyof DeveloperFeatureSettings)[]).filter(
      (key) => updates[key] !== current[key]
    );
    if (changedKeys.length > 0) {
      scheduleDeveloperFeaturePersist(newSettings, changedKeys);
    }
  }
);

/**
 * Initialize developer feature settings from IPC.
 * Call this once at app startup.
 */
export async function initDeveloperFeatureSettings(): Promise<DeveloperFeatureSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return defaultDeveloperFeatureSettings;
  }

  try {
    const [developerMode, developerFeatures] = await Promise.all([
      window.electronAPI.invoke('developer-mode:get'),
      window.electronAPI.invoke('developer-features:get'),
    ]);

    return {
      developerMode: developerMode ?? false,
      developerFeatures: developerFeatures ?? defaultDeveloperFeatureSettings.developerFeatures,
    };
  } catch (error) {
    console.error('[appSettings] Failed to load developer feature settings:', error);
  }

  return defaultDeveloperFeatureSettings;
}

// Re-export developer feature helpers for use in UI
export { DEVELOPER_FEATURES, areAllDeveloperFeaturesEnabled, enableAllDeveloperFeatures, disableAllDeveloperFeatures };

// ============================================================================
// PHASE 8: External Editor Settings
// ============================================================================

/**
 * External editor type options.
 * 'none' means no external editor is configured.
 */
export type ExternalEditorType = 'none' | 'vscode' | 'cursor' | 'webstorm' | 'sublime' | 'vim' | 'nvim' | 'custom';

/**
 * Display names for external editors.
 */
export const EXTERNAL_EDITOR_NAMES: Record<ExternalEditorType, string> = {
  none: 'None',
  vscode: 'VS Code',
  cursor: 'Cursor',
  webstorm: 'WebStorm',
  sublime: 'Sublime Text',
  vim: 'Vim',
  nvim: 'Neovim',
  custom: 'Custom',
};

/**
 * External editor settings.
 */
export interface ExternalEditorSettings {
  editorType: ExternalEditorType;
  customPath?: string;
}

/**
 * Default external editor settings.
 */
const defaultExternalEditorSettings: ExternalEditorSettings = {
  editorType: 'none',
  customPath: '',
};

/**
 * The main external editor settings atom.
 * Should be initialized from IPC on app load.
 */
export const externalEditorSettingsAtom = atom<ExternalEditorSettings>(defaultExternalEditorSettings);

/**
 * Debounce timer for external editor settings persistence.
 */
let externalEditorPersistTimer: ReturnType<typeof setTimeout> | null = null;
const EXTERNAL_EDITOR_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist external editor settings to main process.
 */
function scheduleExternalEditorPersist(settings: ExternalEditorSettings): void {
  if (externalEditorPersistTimer) {
    clearTimeout(externalEditorPersistTimer);
  }
  externalEditorPersistTimer = setTimeout(async () => {
    externalEditorPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      await window.electronAPI.invoke('external-editor:set-settings', settings);
    }
  }, EXTERNAL_EDITOR_PERSIST_DEBOUNCE_MS);
}

// === Derived read-only atoms (slices) ===

/**
 * External editor type.
 */
export const externalEditorTypeAtom = atom(
  (get) => get(externalEditorSettingsAtom).editorType
);

/**
 * Custom external editor path.
 */
export const externalEditorCustomPathAtom = atom(
  (get) => get(externalEditorSettingsAtom).customPath
);

/**
 * Whether an external editor is configured.
 */
export const hasExternalEditorAtom = atom(
  (get) => get(externalEditorSettingsAtom).editorType !== 'none'
);

// === Setter atoms ===

/**
 * Set external editor settings (partial update).
 * Merges with existing settings and triggers persist.
 */
export const setExternalEditorSettingsAtom = atom(
  null,
  (get, set, updates: Partial<ExternalEditorSettings>) => {
    const current = get(externalEditorSettingsAtom);
    const newSettings = { ...current, ...updates };
    set(externalEditorSettingsAtom, newSettings);
    scheduleExternalEditorPersist(newSettings);
  }
);

/**
 * Initialize external editor settings from IPC.
 * Call this once at app startup.
 */
export async function initExternalEditorSettings(): Promise<ExternalEditorSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return defaultExternalEditorSettings;
  }

  try {
    const settings = await window.electronAPI.invoke('external-editor:get-settings');
    if (settings) {
      return {
        editorType: settings.editorType ?? defaultExternalEditorSettings.editorType,
        customPath: settings.customPath ?? defaultExternalEditorSettings.customPath,
      };
    }
  } catch (error) {
    console.error('[appSettings] Failed to load external editor settings:', error);
  }

  return defaultExternalEditorSettings;
}

/**
 * Derived atom for the external editor display name.
 * Returns undefined if no editor is configured.
 */
export const externalEditorNameAtom = atom((get) => {
  const editorType = get(externalEditorTypeAtom);
  if (editorType === 'none') return undefined;
  return EXTERNAL_EDITOR_NAMES[editorType];
});

// ============================================================================
// FILE ACTIONS
// Action atoms for common file operations. Components can use these directly
// without prop drilling callbacks.
// ============================================================================

/**
 * Action atom to open a file in the configured external editor.
 * No-op if no external editor is configured.
 */
export const openInExternalEditorAtom = atom(
  null,
  async (get, _set, filePath: string) => {
    const hasEditor = get(hasExternalEditorAtom);
    if (!hasEditor) return;

    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        await window.electronAPI.openInExternalEditor(filePath);
      } catch (error) {
        console.error('[appSettings] Failed to open in external editor:', error);
      }
    }
  }
);

/**
 * Action atom to reveal a file in the system file browser (Finder on macOS).
 */
export const revealInFinderAtom = atom(
  null,
  async (_get, _set, filePath: string) => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        await window.electronAPI.invoke('show-in-finder', filePath);
      } catch (error) {
        console.error('[appSettings] Failed to reveal in finder:', error);
      }
    }
  }
);

/**
 * Action atom to copy a file path to the clipboard.
 */
export const copyFilePathAtom = atom(
  null,
  async (_get, _set, filePath: string) => {
    try {
      await copyToClipboard(filePath);
    } catch (error) {
      console.error('[appSettings] Failed to copy path to clipboard:', error);
    }
  }
);
