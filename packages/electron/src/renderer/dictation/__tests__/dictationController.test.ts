// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { DICTATION_IPC, DEFAULT_DICTATION_SETTINGS } from '../../../shared/dictation';
import {
  activeDictationAtom,
  dictationSessionAtomFamily,
  dictationSettingsAtom,
} from '../../store/atoms/dictation';
import { reduceDictationEvent } from '../../store/listeners/dictationListeners';
import { DictationController, gatherDictationContextStrings } from '../dictationController';
import { installDictationShortcut } from '../dictationShortcut';
import type { RegisteredDictationTarget } from '../dictationTargets';

function setup(enabled = true) {
  const store = createStore();
  store.set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, enabled });
  const invoke = vi.fn(async (channel: string) =>
    channel === DICTATION_IPC.start ? { ok: true, engine: 'on-device' } : undefined,
  );
  const captureStart = vi.fn(async () => {});
  const captureStop = vi.fn();
  const events: Array<[string, Record<string, unknown> | undefined]> = [];
  const notify = vi.fn();
  let clock = 1000;
  const controller = new DictationController({
    store: store as any,
    invoke,
    send: vi.fn(),
    createCapture: () => ({ start: captureStart, stop: captureStop }) as any,
    notify,
    capture: (event, props) => events.push([event, props]),
    contextStrings: () => ['README.md'],
    newId: () => 'd1',
    now: () => (clock += 500),
  });
  const committed: string[] = [];
  const partials: string[] = [];
  const target: RegisteredDictationTarget = {
    key: 'agent-input:s1',
    surface: 'agent-input',
    kind: 'rich-text',
    hasFocus: () => true,
    showPartial: (t) => partials.push(t),
    clearPartial: vi.fn(),
    commitFinal: (t) => committed.push(t),
  };
  // What dictationListeners does for each IPC event.
  const emit = (event: any) => {
    const atom = dictationSessionAtomFamily(event.dictationId);
    store.set(atom, reduceDictationEvent(store.get(atom), event));
  };
  return { store, controller, invoke, captureStart, captureStop, events, notify, target, committed, partials, emit };
}

describe('DictationController', () => {
  it('refuses to start when dictation is disabled, without touching IPC or the mic', async () => {
    const t = setup(false);
    expect(await t.controller.start(t.target, 'shortcut')).toBe(false);
    expect(t.invoke).not.toHaveBeenCalled();
    expect(t.captureStart).not.toHaveBeenCalled();
    expect(t.store.get(activeDictationAtom)).toBeNull();
  });

  it('streams partials to the target and inserts finals, never submitting', async () => {
    const t = setup();
    expect(await t.controller.start(t.target, 'button')).toBe(true);
    expect(t.invoke).toHaveBeenCalledWith(DICTATION_IPC.start, { dictationId: 'd1', contextStrings: ['README.md'] });
    expect(t.events[0]).toEqual(['dictation_started', { engine: 'on-device', surface: 'agent-input', trigger: 'button' }]);

    t.emit({ dictationId: 'd1', type: 'partial', text: 'hello' });
    t.emit({ dictationId: 'd1', type: 'final', text: 'hello world' });
    expect(t.partials).toEqual(['hello']);
    expect(t.committed).toEqual(['hello world']);
    expect(t.store.get(dictationSessionAtomFamily('d1')).finals).toEqual([]);

    t.controller.stop(false);
    expect(t.captureStop).toHaveBeenCalled();
    expect(t.invoke).toHaveBeenLastCalledWith(DICTATION_IPC.stop, { dictationId: 'd1', cancel: false });
    // A trailing final after stop still lands, then `ended` closes it out.
    t.emit({ dictationId: 'd1', type: 'final', text: 'tail' });
    t.emit({ dictationId: 'd1', type: 'ended' });
    expect(t.committed).toEqual(['hello world', 'tail']);
    const inserted = t.events.find(([e]) => e === 'dictation_inserted');
    expect(inserted?.[1]).toMatchObject({ engine: 'on-device', surface: 'agent-input', segments: 2 });
    expect(JSON.stringify(inserted)).not.toContain('hello');
  });

  it('Esc cancels: clears the pending partial and inserts nothing more', async () => {
    const t = setup();
    await t.controller.start(t.target, 'shortcut');
    t.emit({ dictationId: 'd1', type: 'partial', text: 'draft words' });
    t.controller.stop(true);
    expect(t.target.clearPartial).toHaveBeenCalled();
    expect(t.invoke).toHaveBeenLastCalledWith(DICTATION_IPC.stop, { dictationId: 'd1', cancel: true });
    t.emit({ dictationId: 'd1', type: 'final', text: 'late' });
    expect(t.committed).toEqual([]);
    expect(t.events.some(([e]) => e === 'dictation_inserted')).toBe(false);
  });

  it('a stop requested while start is in flight is applied once start resolves', async () => {
    const t = setup();
    const pending = t.controller.start(t.target, 'shortcut');
    t.controller.stop(false);
    await pending;
    expect(t.captureStop).toHaveBeenCalled();
    expect(t.controller.isRecording()).toBe(false);
  });

  it('keeps early events and releases the mic if main ends the dictation during start', async () => {
    const t = setup();
    let resolveStart!: (v: any) => void;
    t.invoke.mockImplementationOnce(() => new Promise((r) => { resolveStart = r; }) as any);
    const pending = t.controller.start(t.target, 'shortcut');
    t.emit({ dictationId: 'd1', type: 'ready', engine: 'on-device' });
    expect(t.store.get(dictationSessionAtomFamily('d1')).status).toBe('listening');
    // Dictation turned off in settings: main cancels and sends `ended`.
    t.emit({ dictationId: 'd1', type: 'ended' });
    resolveStart({ ok: true, engine: 'on-device' });
    expect(await pending).toBe(false);
    // The mic opens alongside the engine start; it must be closed again.
    expect(t.captureStop).toHaveBeenCalledTimes(t.captureStart.mock.calls.length);
    expect(t.controller.isRecording()).toBe(false);
  });

  it('shows the start failure reason and releases the slot', async () => {
    const t = setup();
    t.invoke.mockImplementationOnce(async () => ({ ok: false, reason: 'no-engine' }) as any);
    expect(await t.controller.start(t.target, 'button')).toBe(false);
    expect(t.notify).toHaveBeenCalledWith('Dictation could not start', expect.stringContaining('No speech engine'));
    expect(t.captureStop).toHaveBeenCalledTimes(t.captureStart.mock.calls.length);
    expect(t.controller.isRecording()).toBe(false);
  });
});

describe('gatherDictationContextStrings', () => {
  it('is capped, skips dotfiles and node_modules, and adds stems', () => {
    const tree = [
      { name: '.git', isDirectory: true },
      { name: 'node_modules', isDirectory: true, children: [{ name: 'leftpad.js' }] },
      { name: 'src', isDirectory: true, children: [{ name: 'AIInput.tsx' }] },
    ];
    const out = gatherDictationContextStrings('/w/docs/DICTATION.md', tree);
    expect(out).toEqual(['DICTATION.md', 'DICTATION', 'src', 'AIInput.tsx', 'AIInput']);
    const big = Array.from({ length: 500 }, (_, i) => ({ name: `f${i}.ts` }));
    expect(gatherDictationContextStrings(null, big)).toHaveLength(100);
  });
});

describe('installDictationShortcut', () => {
  function harness(enabled = true, system = false) {
    const listeners: Record<string, (e: any) => void> = {};
    const target = {
      addEventListener: (type: string, fn: any) => { listeners[type] = fn; },
      removeEventListener: vi.fn(),
    };
    let recording = false;
    const controller = {
      isEnabled: () => enabled,
      usesSystemDictation: () => system,
      isRecording: () => recording,
      startInFocused: vi.fn(async () => { recording = true; return true; }),
      stop: vi.fn(() => { recording = false; }),
    };
    let clock = 0;
    installDictationShortcut(() => controller as any, target as any, () => clock);
    const key = (type: 'keydown' | 'keyup', extra: Record<string, unknown> = {}) => {
      const e = { code: 'Space', key: ' ', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, repeat: false,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
      listeners[type](e);
      return e;
    };
    return { controller, key, advance: (ms: number) => { clock += ms; } };
  }

  it('hold to talk: releasing after a hold stops', async () => {
    const h = harness();
    h.key('keydown');
    await Promise.resolve();
    expect(h.controller.startInFocused).toHaveBeenCalledWith('shortcut');
    h.advance(1000);
    h.key('keyup');
    expect(h.controller.stop).toHaveBeenCalledWith(false);
  });

  it('a quick tap keeps listening until the next tap', async () => {
    const h = harness();
    h.key('keydown');
    await Promise.resolve();
    h.advance(100);
    h.key('keyup');
    expect(h.controller.stop).not.toHaveBeenCalled();
    h.key('keydown');
    expect(h.controller.stop).toHaveBeenCalledWith(false);
  });

  it('Esc while recording cancels and is consumed', async () => {
    const h = harness();
    h.key('keydown');
    await Promise.resolve();
    const esc = h.key('keydown', { key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false });
    expect(h.controller.stop).toHaveBeenCalledWith(true);
    expect(esc.stopPropagation).toHaveBeenCalled();
  });

  it('is inert when dictation is disabled: the key is not consumed', () => {
    const h = harness(false);
    const e = h.key('keydown');
    expect(h.controller.startInFocused).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('DictationController mic startup', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  function harness(opts: { micWarmMs?: number } = {}) {
    const store = createStore();
    store.set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, enabled: true });
    const starts: Array<ReturnType<typeof deferred<any>>> = [];
    const invoke = vi.fn((channel: string) => {
      if (channel !== DICTATION_IPC.start) return Promise.resolve(undefined);
      const d = deferred<any>();
      starts.push(d);
      return d.promise;
    });
    const send = vi.fn();
    const captures: Array<{ start: any; stop: any; feed: (b64: string) => void }> = [];
    const createCapture = vi.fn(() => {
      const c: any = { feed: () => {} };
      c.start = vi.fn(async (cb: (b64: string) => void) => { c.feed = cb; });
      c.stop = vi.fn();
      captures.push(c);
      return c;
    });
    let n = 0;
    const controller = new DictationController({
      store: store as any,
      invoke: invoke as any,
      send,
      createCapture: createCapture as any,
      notify: vi.fn(),
      capture: vi.fn(),
      contextStrings: () => [],
      newId: () => `d${++n}`,
      now: () => Date.now(),
      micWarmMs: opts.micWarmMs,
    });
    const target = (key: string): RegisteredDictationTarget => ({
      key, surface: 'agent-input', kind: 'rich-text', hasFocus: () => true,
      showPartial: vi.fn(), clearPartial: vi.fn(), commitFinal: vi.fn(),
    });
    return { store, controller, starts, send, captures, createCapture, target };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('opens the mic before the engine is ready and sends what was said meanwhile', async () => {
    const t = harness();
    const started = t.controller.start(t.target('a'), 'shortcut');
    await flush();
    expect(t.captures).toHaveLength(1);
    expect(t.captures[0].start).toHaveBeenCalled();
    t.captures[0].feed('AAAA'); // device warm-up silence
    t.captures[0].feed('c3BlZWNo');
    expect(t.send).not.toHaveBeenCalled();
    t.starts[0].resolve({ ok: true, engine: 'on-device' });
    await started;
    t.captures[0].feed('bW9yZQ==');
    expect(t.send.mock.calls).toEqual([
      [DICTATION_IPC.audio, 'd1', 'c3BlZWNo'],
      [DICTATION_IPC.audio, 'd1', 'bW9yZQ=='],
    ]);
  });

  it('releases the mic when the engine refuses to start', async () => {
    const t = harness();
    const started = t.controller.start(t.target('a'), 'shortcut');
    await flush();
    t.starts[0].resolve({ ok: false, reason: 'busy' });
    expect(await started).toBe(false);
    expect(t.captures[0].stop).toHaveBeenCalled();
  });

  it('does not leave the mic running when a second start overlaps the first', async () => {
    const t = harness();
    const a = t.controller.start(t.target('a'), 'shortcut');
    await flush();
    const b = t.controller.start(t.target('b'), 'button');
    await flush();
    t.starts[1].resolve({ ok: false, reason: 'busy' });
    await b;
    t.starts[0].resolve({ ok: true, engine: 'on-device' });
    await a;
    await flush();
    const running = t.captures.filter((c) => c.start.mock.calls.length > 0 && c.stop.mock.calls.length === 0);
    expect(running).toHaveLength(t.controller.isRecording() ? 1 : 0);
    expect(t.store.get(activeDictationAtom) !== null).toBe(t.controller.isRecording());
  });

  it('keeps the mic warm briefly so the next dictation skips device warm-up', async () => {
    vi.useFakeTimers();
    try {
      const t = harness({ micWarmMs: 5000 });
      const first = t.controller.start(t.target('a'), 'shortcut');
      await vi.advanceTimersByTimeAsync(0);
      t.starts[0].resolve({ ok: true, engine: 'on-device' });
      await first;
      t.controller.stop(false);
      expect(t.captures[0].stop).not.toHaveBeenCalled();
      t.captures[0].feed('aWRsZQ=='); // audio while parked is dropped
      const second = t.controller.start(t.target('a'), 'shortcut');
      await vi.advanceTimersByTimeAsync(0);
      t.starts[1].resolve({ ok: true, engine: 'on-device' });
      await second;
      expect(t.createCapture).toHaveBeenCalledTimes(1);
      t.captures[0].feed('bmV4dA==');
      expect(t.send).toHaveBeenLastCalledWith(DICTATION_IPC.audio, 'd2', 'bmV4dA==');
      expect(t.send).not.toHaveBeenCalledWith(DICTATION_IPC.audio, expect.anything(), 'aWRsZQ==');
      t.controller.stop(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(t.captures[0].stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('macOS system dictation', () => {
  it('the controller hands off to macOS without opening our mic or engine', async () => {
    const store = createStore();
    store.set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, enabled: true, engine: 'auto' });
    const invoke = vi.fn(async () => ({ ok: true }));
    const createCapture = vi.fn();
    const events: string[] = [];
    const controller = new DictationController({
      store: store as any, invoke: invoke as any, send: vi.fn(), createCapture: createCapture as any,
      notify: vi.fn(), capture: (e) => events.push(e), contextStrings: () => [], newId: () => 'd1', now: () => 0,
      isMac: true,
    });
    const target = { key: 'a', surface: 'agent-input', kind: 'rich-text', hasFocus: () => true,
      showPartial: vi.fn(), clearPartial: vi.fn(), commitFinal: vi.fn() } as RegisteredDictationTarget;
    expect(controller.usesSystemDictation()).toBe(true);
    expect(await controller.start(target, 'button')).toBe(true);
    expect(invoke).toHaveBeenCalledWith(DICTATION_IPC.systemStart);
    expect(invoke).not.toHaveBeenCalledWith(DICTATION_IPC.start, expect.anything());
    expect(createCapture).not.toHaveBeenCalled();
    expect(events).toEqual(['dictation_started']);

    // An explicit engine choice on a Mac still uses our pipeline.
    store.set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, enabled: true, engine: 'on-device' });
    expect(controller.usesSystemDictation()).toBe(false);
  });

  it('the shortcut starts system dictation on key press, once per press', async () => {
    const listeners: Record<string, (e: any) => void> = {};
    const controller = {
      isEnabled: () => true,
      usesSystemDictation: () => true,
      isRecording: () => false,
      startInFocused: vi.fn(async () => true),
      stop: vi.fn(),
    };
    installDictationShortcut(() => controller as any, { addEventListener: (t: string, f: any) => { listeners[t] = f; }, removeEventListener: vi.fn() } as any, () => 0);
    const ev = (extra: Record<string, unknown>) => ({ code: 'Space', key: ' ', ctrlKey: true, altKey: true, metaKey: false,
      shiftKey: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra });
    const down = ev({});
    listeners.keydown(down);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(controller.startInFocused).toHaveBeenCalledWith('shortcut');
    listeners.keydown(ev({ repeat: true }));
    listeners.keyup(ev({ code: 'Enter', key: 'Enter', ctrlKey: false, altKey: false }));
    expect(controller.startInFocused).toHaveBeenCalledTimes(1);
    expect(controller.stop).not.toHaveBeenCalled();
  });
});

describe('macOS system dictation outside registered surfaces', () => {
  it('starts in any focused editable field, but not when nothing editable has focus', async () => {
    const store = createStore();
    store.set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, enabled: true, engine: 'system' });
    const invoke = vi.fn(async () => ({ ok: true }));
    let active: unknown = { isContentEditable: true, tagName: 'DIV' };
    const controller = new DictationController({
      store: store as any, invoke: invoke as any, send: vi.fn(), createCapture: vi.fn() as any,
      notify: vi.fn(), capture: vi.fn(), contextStrings: () => [], newId: () => 'd1', now: () => 0,
      isMac: true, activeElement: () => active as Element,
    });
    expect(await controller.startInFocused('shortcut')).toBe(true);
    expect(invoke).toHaveBeenCalledWith(DICTATION_IPC.systemStart);
    invoke.mockClear();
    active = { isContentEditable: false, tagName: 'BUTTON' };
    expect(await controller.startInFocused('shortcut')).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

