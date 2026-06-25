/**
 * RTL Support — Nimbalyst Extension
 * Entry point
 *
 * issue #237: automatic RTL/LTR direction detection for agent responses,
 * user prompts, and markdown content.
 *
 * Architecture (official Nimbalyst APIs):
 *  - hostComponent: RtlTranscriptHost — rehype plugin + component overrides
 *  - inputRtl: applies RTL to user input fields
 *  - settings: configuration service + localStorage + settingsPanel UI
 *
 * @nimbalyst/runtime is external and provided by the host.
 */

import './styles.css';

import { RtlTranscriptHost } from './RtlTranscriptHost';
import { RtlSettingsPanel } from './RtlSettingsPanel';
import { loadSettings, saveSettings, resetSettings, type RtlSettings } from './settings';
import { startInputRtl, stopInputRtl } from './inputRtl';
import { setDebug, isDebug } from './debug';

/** hostComponents — referenced via manifest > contributions.hostComponents */
export const hostComponents = {
  RtlTranscriptHost,
};

/** settingsPanel — referenced via manifest > contributions.settingsPanel */
export const settingsPanel = {
  RtlSettingsPanel,
};

export const components = {};

interface ExtensionContext {
  services?: {
    configuration?: {
      get<T>(key: string, defaultValue?: T): T;
      update(key: string, value: unknown, scope?: 'user' | 'workspace'): Promise<void>;
    };
  };
  subscriptions?: Array<{ dispose(): void }>;
}

let currentSettings: RtlSettings = loadSettings();

/**
 * Activate the extension.
 */
export function activate(context?: ExtensionContext): void {
  currentSettings = loadSettings();

  // Sync with configuration service (manifest settings)
  if (context?.services?.configuration) {
    const config = context.services.configuration;
    const c: RtlSettings = {
      enabled: config.get('rtlSupport.enabled', currentSettings.enabled),
      mode: config.get<'auto' | 'rtl' | 'ltr'>('rtlSupport.mode', currentSettings.mode),
      threshold: config.get<number>('rtlSupport.threshold', currentSettings.threshold),
      perBlock: config.get<boolean>('rtlSupport.perBlock', currentSettings.perBlock),
      inputRtl: config.get<boolean>('rtlSupport.inputRtl', currentSettings.inputRtl),
      inlineDetect: config.get<boolean>('rtlSupport.inlineDetect', currentSettings.inlineDetect),
      debug: config.get<boolean>('rtlSupport.debug', currentSettings.debug),
    };
    currentSettings = c;
    saveSettings(c);
  }

  // Debug flag
  setDebug(currentSettings.debug);

  // Input RTL
  if (currentSettings.enabled && currentSettings.inputRtl && typeof document !== 'undefined') {
    startInputRtl(document.body, currentSettings);
  }

  // Keyboard shortcut
  registerKeyboardShortcut();

  // Runtime API
  registerRuntimeApi();

  if (isDebug()) {
    console.log('[RTL Support] Activated', currentSettings);
  }
}

/** Keyboard shortcut: Ctrl+Shift+R (or Cmd+Shift+R on mac) to toggle */
function registerKeyboardShortcut(): void {
  if (typeof document === 'undefined') return;

  const handler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
      e.preventDefault();
      const api = (globalThis as Record<string, unknown>).nimbalystRtlSupport as {
        toggle: () => boolean;
      } | undefined;
      if (api) {
        const enabled = api.toggle();
        console.log('[RTL Support] ' + (enabled ? 'enabled' : 'disabled') + ' via shortcut');
      }
    }
  };

  document.addEventListener('keydown', handler);
  // Store handler for cleanup in deactivate
  (globalThis as Record<string, unknown>)['__rtlShortcutHandler'] = handler;
}

function registerRuntimeApi(): void {
  const api = {
    getSettings: (): RtlSettings => ({ ...currentSettings }),
    updateSettings: (next: Partial<RtlSettings>): RtlSettings => {
      const merged = { ...currentSettings, ...next };
      saveSettings(merged);
      currentSettings = merged;
      setDebug(merged.debug);
      return merged;
    },
    reset: (): RtlSettings => {
      const defaults = resetSettings();
      currentSettings = defaults;
      setDebug(defaults.debug);
      return defaults;
    },
    enable: (): void => { api.updateSettings({ enabled: true }); },
    disable: (): void => { api.updateSettings({ enabled: false }); },
    toggle: (): boolean => {
      const next = !currentSettings.enabled;
      api.updateSettings({ enabled: next });
      return next;
    },
  };

  (globalThis as Record<string, unknown>)['nimbalystRtlSupport'] = api;
}

export function deactivate(): void {
  // Keyboard shortcut cleanup
  const handler = (globalThis as Record<string, unknown>)['__rtlShortcutHandler'];
  if (typeof handler === 'function' && typeof document !== 'undefined') {
    document.removeEventListener('keydown', handler as EventListener);
    delete (globalThis as Record<string, unknown>)['__rtlShortcutHandler'];
  }

  stopInputRtl();
  delete (globalThis as Record<string, unknown>).nimbalystRtlSupport;
}
