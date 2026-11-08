/**
 * Dictation IPC (speech-to-text into inputs and editors). Separate from Voice
 * Mode: never speaks, never submits. Contract: src/shared/dictation.ts.
 */

import { app, BrowserWindow, Menu, systemPreferences, type WebContents } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DICTATION_IPC,
  DICTATION_SAMPLE_RATE,
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
import { DictationController, type DictationDebugRecording, type DictationTarget } from './DictationController';
import { normalizeDictationSettings } from './dictationSettings';
import { OnDeviceDictationEngine } from './OnDeviceDictationEngine';
import { OpenAIDictationEngine } from './OpenAIDictationEngine';

const SETTINGS_KEY = 'dictation';
const HELPER_NAME = 'nimbalyst-dictation';

let controller: DictationController | null = null;

/**
 * Dev builds only: keep each dictation's audio as a WAV next to the text the
 * engine produced, so accuracy can be replayed through engine variants.
 * Folder: <userData>/dictation-debug, newest 30 kept.
 */
function writeDictationDebugRecording(recording: DictationDebugRecording): void {
  const dir = path.join(app.getPath('userData'), 'dictation-debug');
  fs.mkdirSync(dir, { recursive: true });
  const pcm = Buffer.concat(recording.pcm16);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(DICTATION_SAMPLE_RATE, 24); header.writeUInt32LE(DICTATION_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const base = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${recording.engine}`);
  fs.writeFileSync(`${base}.wav`, Buffer.concat([header, pcm]));
  fs.writeFileSync(`${base}.json`, JSON.stringify({ engine: recording.engine, finals: recording.finals }, null, 2));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 30))) {
    fs.rmSync(path.join(dir, old), { force: true });
    fs.rmSync(path.join(dir, old.replace(/\.wav$/, '.json')), { force: true });
  }
}

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
    platform: process.platform,
    recordDebugAudio: app.isPackaged ? undefined : writeDictationDebugRecording,
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

  // macOS system dictation: send Edit > Start Dictation's AppKit action to the
  // focused text view. It starts listening in about 40ms and inserts text
  // itself. Only works when no keys are held (the renderer fires it on key
  // release); from a held shortcut it stalls before the recognizer starts.
  safeHandle(DICTATION_IPC.systemStart, () => {
    if (process.platform !== 'darwin' || !getSettings().enabled) return { ok: false };
    if (dictation.isActive()) dictation.cancelActive();
    logger.main.info('[Dictation] system dictation requested');
    Menu.sendActionToFirstResponder('startDictation:');
    return { ok: true };
  });

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
