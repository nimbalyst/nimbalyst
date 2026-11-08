// @vitest-environment node
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import type { DictationEvent, DictationSettings } from '../../../../shared/dictation';
import { DictationController, type DictationTarget } from '../DictationController';
import { selectDictationEngine, type DictationEngine } from '../DictationEngine';
import { createLineSplitter, parseHelperLine } from '../helperProtocol';
import { OnDeviceDictationEngine } from '../OnDeviceDictationEngine';

/** Minimal stand-in for the Swift helper's ChildProcess. */
function fakeHelper() {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  const commands: any[] = [];
  const split = createLineSplitter((line) => { if (line) commands.push(JSON.parse(line)); });
  proc.stdin.on('data', split);
  proc.commands = commands;
  proc.reply = (message: object) => proc.stdout.write(JSON.stringify(message) + '\n');
  return proc;
}

function onDeviceEngine(spawnHelper: () => any) {
  return new OnDeviceDictationEngine({
    platform: 'darwin',
    osRelease: '25.0.0',
    helperPath: '/fake/nimbalyst-dictation',
    fileExists: () => true,
    spawnHelper,
    log: () => {},
  });
}

function stubEngine(id: 'on-device' | 'openai', available: boolean): DictationEngine {
  return { id, isAvailable: () => available, start: vi.fn(), dispose: vi.fn() } as unknown as DictationEngine;
}

function target(events: DictationEvent[]): DictationTarget {
  return { id: 1, isDestroyed: () => false, sendEvent: (event) => events.push(event) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('dictation helper protocol', () => {
  it('reassembles JSON lines split across stdout chunks and drops malformed ones', () => {
    const messages: unknown[] = [];
    const feed = createLineSplitter((line) => {
      const message = parseHelperLine(line);
      if (message) messages.push(message);
    });
    feed('{"type":"partial","id":"d1","te');
    feed('xt":"hello"}\nnot json\n{"type":"final","id":"d1","text":"hello world"}\n{"type":"ended"');
    feed(',"id":"d1"}\n{"type":"partial","id":"d1"}\n');

    expect(messages).toEqual([
      { type: 'partial', id: 'd1', text: 'hello' },
      { type: 'final', id: 'd1', text: 'hello world' },
      { type: 'ended', id: 'd1' },
    ]);
  });
});

describe('dictation engine selection', () => {
  it('auto prefers on-device, falls back to OpenAI, and explicit choices never fall back', () => {
    expect(selectDictationEngine('auto', { system: false, onDevice: true, openai: true })).toBe('on-device');
    expect(selectDictationEngine('auto', { system: false, onDevice: false, openai: true })).toBe('openai');
    expect(selectDictationEngine('auto', { system: false, onDevice: false, openai: false })).toBeNull();
    expect(selectDictationEngine('on-device', { system: false, onDevice: false, openai: true })).toBeNull();
    expect(selectDictationEngine('openai', { system: false, onDevice: true, openai: false })).toBeNull();
  });

  it('on-device is unavailable off macOS, before macOS 13, or without the helper binary', () => {
    const make = (platform: NodeJS.Platform, osRelease: string, exists: boolean) => new OnDeviceDictationEngine({
      platform, osRelease, helperPath: '/x', fileExists: () => exists, spawnHelper: vi.fn(), log: () => {},
    }).isAvailable();
    expect(make('darwin', '25.1.0', true)).toBe(true);
    expect(make('win32', '10.0.0', true)).toBe(false);
    expect(make('darwin', '21.6.0', true)).toBe(false);
    expect(make('darwin', '25.1.0', false)).toBe(false);
  });
});

describe('DictationController', () => {
  function controllerWith(settings: DictationSettings, onDevice: DictationEngine, extra: Partial<{ voice: boolean; mic: boolean }> = {}) {
    const ensureMicrophoneAccess = vi.fn(async () => extra.mic ?? true);
    const controller = new DictationController({
      getSettings: () => settings,
      engines: { 'on-device': onDevice, openai: stubEngine('openai', false) },
      isVoiceModeActive: () => extra.voice ?? false,
      ensureMicrophoneAccess,
      log: () => {},
      platform: 'darwin',
    });
    return { controller, ensureMicrophoneAccess };
  }

  it('returns disabled without asking for the mic or launching the helper', async () => {
    const spawnHelper = vi.fn(fakeHelper);
    const { controller, ensureMicrophoneAccess } = controllerWith({ enabled: false, engine: 'auto' }, onDeviceEngine(spawnHelper));

    await expect(controller.start(target([]), { dictationId: 'd1' })).resolves.toEqual({ ok: false, reason: 'disabled' });
    expect(spawnHelper).not.toHaveBeenCalled();
    expect(ensureMicrophoneAccess).not.toHaveBeenCalled();
  });

  it('returns no-engine when nothing is available and busy while Voice Mode is active', async () => {
    const none = controllerWith({ enabled: true, engine: 'auto' }, stubEngine('on-device', false));
    await expect(none.controller.start(target([]), { dictationId: 'd1' })).resolves.toEqual({ ok: false, reason: 'no-engine' });

    const spawnHelper = vi.fn(fakeHelper);
    const voice = controllerWith({ enabled: true, engine: 'auto' }, onDeviceEngine(spawnHelper), { voice: true });
    await expect(voice.controller.start(target([]), { dictationId: 'd1' })).resolves.toEqual({ ok: false, reason: 'busy' });
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it('runs an on-device dictation end to end and ends once when the helper dies', async () => {
    const helper = fakeHelper();
    const { controller } = controllerWith({ enabled: true, engine: 'auto', language: 'en-US' }, onDeviceEngine(() => helper));
    const events: DictationEvent[] = [];

    const started = controller.start(target(events), { dictationId: 'd1', contextStrings: ['DictationService', 'DictationService', ''] });
    await tick();
    expect(helper.commands[0]).toEqual({ type: 'start', id: 'd1', locale: 'en-US', contextualStrings: ['DictationService'] });

    helper.reply({ type: 'ready', id: 'd1' });
    await expect(started).resolves.toEqual({ ok: true, engine: 'on-device' });

    controller.audio(target(events), 'd1', 'AAAA');
    controller.audio(target(events), 'other', 'BBBB');
    helper.reply({ type: 'partial', id: 'd1', text: 'hel' });
    helper.reply({ type: 'final', id: 'd1', text: 'hello' });
    await tick();
    expect(helper.commands.filter((c: any) => c.type === 'audio')).toEqual([{ type: 'audio', id: 'd1', data: 'AAAA' }]);

    helper.exitCode = 1;
    helper.emit('exit', 1, null);
    await tick();
    expect(events.map((e) => e.type)).toEqual(['ready', 'partial', 'final', 'error', 'ended']);
    expect(controller.isActive()).toBe(false);
  });

  it('maps a helper speech-permission error to speech-permission-denied', async () => {
    const helper = fakeHelper();
    const { controller } = controllerWith({ enabled: true, engine: 'on-device' }, onDeviceEngine(() => helper));
    const started = controller.start(target([]), { dictationId: 'd1' });
    await tick();
    helper.reply({ type: 'error', id: 'd1', code: 'speech-permission-denied', message: 'no' });
    helper.reply({ type: 'ended', id: 'd1' });
    await expect(started).resolves.toMatchObject({ ok: false, reason: 'speech-permission-denied' });
    expect(controller.isActive()).toBe(false);
  });
});
