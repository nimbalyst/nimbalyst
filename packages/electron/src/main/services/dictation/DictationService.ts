/**
 * Dictation IPC (speech-to-text into inputs and editors). Separate from Voice
 * Mode: never speaks, never submits. Contract: src/shared/dictation.ts.
 */

import { app, BrowserWindow, systemPreferences, type WebContents } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DICTATION_IPC,
  type DictationSettings,
  type DictationStartRequest,
  type DictationStopRequest,
} from '../../../shared/dictation';
import { safeHandle, safeOn } from '../../utils/ipcRegistry';
import Store from '../../utils/privateSettingsStore';
import { logger } from '../../utils/logger';
import { getProviderCredentials } from '../credentials/providerCredentials';
import { ensureVoiceMicrophoneAccess } from '../voice/microphoneAccess';
import { getActiveVoiceSessionId } from '../voice/VoiceModeService';
import { DictationController, type DictationTarget } from './DictationController';
import { normalizeDictationSettings } from './dictationSettings';
import { OnDeviceDictationEngine } from './OnDeviceDictationEngine';
import { OpenAIDictationEngine } from './OpenAIDictationEngine';

const SETTINGS_KEY = 'dictation';
const HELPER_NAME = 'nimbalyst-dictation';

let controller: DictationController | null = null;

export function getDictationHelperPath(): string {
  // Packaged: mac.extraResources copies it to Contents/Resources/dictation-helper.
  // Dev: scripts/build-dictation-helper.sh writes resources/dictation-helper-bin.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dictation-helper', HELPER_NAME)
    : path.join(app.getAppPath(), 'resources', 'dictation-helper-bin', HELPER_NAME);
}

function toTarget(sender: WebContents): DictationTarget {
  return {
    id: sender.id,
    isDestroyed: () => sender.isDestroyed(),
    sendEvent: (event) => sender.send(DICTATION_IPC.event, event),
  };
}

/** True while any dictation is running (Voice Mode can use this to refuse to start). */
export function isDictationActive(): boolean {
  return controller?.isActive() ?? false;
}

export function initDictationService(): void {
  if (controller) return;

  const settingsStore = new Store<Record<string, unknown>>({
    name: 'nimbalyst-settings',
    watch: true,
  });
  const getSettings = (): DictationSettings => normalizeDictationSettings(settingsStore.get(SETTINGS_KEY));
  const log = (message: string) => logger.main.info(message);

  const dictation = new DictationController({
    getSettings,
    engines: {
      'on-device': new OnDeviceDictationEngine({
        platform: process.platform,
        osRelease: os.release(),
        helperPath: getDictationHelperPath(),
        fileExists: (p) => fs.existsSync(p),
        spawnHelper: (p) => spawn(p, [], { stdio: ['pipe', 'pipe', 'pipe'] }),
        log,
      }),
      openai: new OpenAIDictationEngine({
        getApiKey: () => getProviderCredentials().get('openai') || undefined,
        log,
      }),
    },
    isVoiceModeActive: () => getActiveVoiceSessionId() !== null,
    ensureMicrophoneAccess: async () => {
      try {
        await ensureVoiceMicrophoneAccess(process.platform, systemPreferences);
        return true;
      } catch {
        return false;
      }
    },
    log,
  });
  controller = dictation;

  const watchedSenders = new WeakSet<WebContents>();
  const watchSender = (sender: WebContents) => {
    if (watchedSenders.has(sender)) return;
    watchedSenders.add(sender);
    const senderId = sender.id;
    sender.once('destroyed', () => dictation.cancelActive(senderId));
  };

  safeHandle(DICTATION_IPC.getSettings, () => getSettings());

  safeHandle(DICTATION_IPC.setSettings, (_event, update: Partial<DictationSettings>) => {
    if (!update || typeof update !== 'object') {
      throw new Error('dictation:set-settings requires a settings object');
    }
    const settings = normalizeDictationSettings({ ...getSettings(), ...update });
    settingsStore.set(SETTINGS_KEY, settings);
    if (!settings.enabled) dictation.cancelActive();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(DICTATION_IPC.settingsChanged, settings);
    }
    return settings;
  });

  safeHandle(DICTATION_IPC.getAvailability, () => dictation.getAvailability());

  safeHandle(DICTATION_IPC.start, (event, request: DictationStartRequest) => {
    watchSender(event.sender);
    return dictation.start(toTarget(event.sender), request);
  });

  safeOn(DICTATION_IPC.audio, (event, dictationId: string, base64Pcm16: string) => {
    dictation.audio(toTarget(event.sender), dictationId, base64Pcm16);
  });

  safeHandle(DICTATION_IPC.stop, (event, request: DictationStopRequest) => {
    dictation.stop(toTarget(event.sender), request);
  });

  app.on('will-quit', () => dictation.dispose());
}
