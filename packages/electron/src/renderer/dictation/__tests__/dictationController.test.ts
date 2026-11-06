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
    expect(t.captureStart).not.toHaveBeenCalled();
    expect(t.controller.isRecording()).toBe(false);
  });

  it('shows the start failure reason and releases the slot', async () => {
    const t = setup();
    t.invoke.mockImplementationOnce(async () => ({ ok: false, reason: 'no-engine' }) as any);
    expect(await t.controller.start(t.target, 'button')).toBe(false);
    expect(t.notify).toHaveBeenCalledWith('Dictation could not start', expect.stringContaining('No speech engine'));
    expect(t.captureStart).not.toHaveBeenCalled();
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
  function harness(enabled = true) {
    const listeners: Record<string, (e: any) => void> = {};
    const target = {
      addEventListener: (type: string, fn: any) => { listeners[type] = fn; },
      removeEventListener: vi.fn(),
    };
    let recording = false;
    const controller = {
      isEnabled: () => enabled,
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
