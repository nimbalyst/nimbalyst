// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinFrontmatter, splitFrontmatter } from '../frontmatter';
import { PendingSave } from '../pendingSave';

describe('mobile editor frontmatter', () => {
  it('re-attaches the frontmatter byte for byte around an edited body', () => {
    const file = '---\n# kept comment\nid: 01J\ntitle: "R/D: plans?"\ntags: [a,   b]\n---\n\n# Body\n\nText.\n';
    const { prefix, body } = splitFrontmatter(file);
    expect(body).toBe('# Body\n\nText.\n');
    expect(joinFrontmatter(prefix, '# Body\n\nText edited.\n')).toBe(
      '---\n# kept comment\nid: 01J\ntitle: "R/D: plans?"\ntags: [a,   b]\n---\n\n# Body\n\nText edited.\n',
    );
    expect(joinFrontmatter(prefix, body)).toBe(file);
  });

  it('starts a new line when the file ended on the closing delimiter', () => {
    const { prefix, body } = splitFrontmatter('---\nid: x\n---');
    expect(body).toBe('');
    expect(joinFrontmatter(prefix, 'Edited body\n')).toBe('---\nid: x\n---\nEdited body\n');
    expect(joinFrontmatter(prefix, '')).toBe('---\nid: x\n---');
    const crlf = splitFrontmatter('---\r\nid: x\r\n---');
    expect(joinFrontmatter(crlf.prefix, 'Edited body\r\n')).toBe('---\r\nid: x\r\n---\r\nEdited body\r\n');
  });

  it('treats text without a closed block as all body', () => {
    expect(splitFrontmatter('# No frontmatter\n')).toEqual({ prefix: '', body: '# No frontmatter\n' });
    expect(splitFrontmatter('---\nid: x\nno close\n')).toEqual({ prefix: '', body: '---\nid: x\nno close\n' });
  });
});

describe('mobile editor pending save', () => {
  function harness() {
    const saves: Array<[number, string]> = [];
    const dirty: boolean[] = [];
    const reloads: string[] = [];
    const save = new PendingSave({
      onSave: (revision, body) => saves.push([revision, body]),
      onDirty: (d) => dirty.push(d),
      onReload: (body) => {
        reloads.push(body);
        save.loaded(body); // the host reloads it as a load
      },
    });
    return { save, saves, dirty, reloads, bodies: () => saves.map(([, body]) => body) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an undo inside the debounce cancels the save of the undone text', () => {
    const { save, bodies, dirty } = harness();
    save.loaded('A');
    save.edited('AB');
    save.edited('A');
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual([]);
    expect(dirty).toEqual([true, false]);

    save.edited('AC');
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual(['AC']);
  });

  // R3-2: the explicit save is emitted by the bundle and confirmed only by its ack.
  it('an undo while a native Save is in flight saves the undone text after the ack', () => {
    const { save, saves, bodies } = harness();
    save.loaded('A');
    save.edited('AB');
    save.flush();
    expect(saves).toEqual([[1, 'AB']]);
    save.edited('A');
    expect(save.dirty).toBe(true);
    save.ack(1, true);
    expect(save.confirmed).toBe('AB');
    expect(save.dirty).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual(['AB', 'A']);
    save.ack(2, true);
    expect(save.confirmed).toBe('A');
    expect(save.dirty).toBe(false);
  });

  // R3-3: a failed save never moves `confirmed`.
  it('a failed autosave keeps the disk body as confirmed, so undo then redo saves again', () => {
    const { save, saves, bodies } = harness();
    save.loaded('A');
    save.edited('AB');
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual([[1, 'AB']]);
    save.ack(1, false);
    expect(save.confirmed).toBe('A');
    expect(save.dirty).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(bodies()).toEqual(['AB']); // no retry loop

    save.edited('A');
    expect(save.dirty).toBe(false);
    save.edited('AB');
    expect(save.dirty).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual(['AB', 'AB']);
    save.ack(2, true);
    expect(save.confirmed).toBe('AB');
    expect(save.dirty).toBe(false);
  });

  it('a failed save is retried by the next flush', () => {
    const { save, bodies } = harness();
    save.loaded('A');
    save.edited('AB');
    vi.advanceTimersByTime(1000);
    save.ack(1, false);
    save.flush();
    expect(bodies()).toEqual(['AB', 'AB']);
  });

  it('content typed while a save is in flight waits for its ack, then saves', () => {
    const { save, saves } = harness();
    save.loaded('A');
    save.edited('AB');
    vi.advanceTimersByTime(1000);
    save.edited('ABC');
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual([[1, 'AB']]); // at most one in flight
    save.ack(1, true);
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual([[1, 'AB'], [2, 'ABC']]);
    save.ack(1, true); // a stale ack changes nothing
    expect(save.confirmed).toBe('AB');
    save.ack(2, true);
    expect(save.dirty).toBe(false);
  });

  it('a flush while a save is in flight saves the newer content as soon as it is acked', () => {
    const { save, saves } = harness();
    save.loaded('A');
    save.edited('AB');
    save.flush();
    save.edited('ABC');
    save.flush();
    save.ack(1, true);
    expect(saves).toEqual([[1, 'AB'], [2, 'ABC']]);
    expect(save.finalBody()).toBe('ABC');
  });

  it('undoing edits after a deferred remote body loads that body instead of keeping stale text', () => {
    const { save, bodies, reloads, dirty } = harness();
    save.loaded('A');
    save.edited('AB');
    save.deferRemote('REMOTE');
    save.edited('A');
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual([]);
    expect(reloads).toEqual(['REMOTE']);
    expect(save.confirmed).toBe('REMOTE');

    save.edited('REMOTE!');
    save.edited('REMOTE');
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual([]);
    expect(dirty).toEqual([true, false, true, false]);
  });

  it('typing the deferred remote text is clean; a persisted local save supersedes the deferred body', () => {
    const { save, bodies, reloads } = harness();
    save.loaded('A');
    save.edited('AB');
    save.deferRemote('AB');
    save.edited('AB');
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual([]);
    expect(reloads).toEqual([]);

    save.edited('ABC');
    save.deferRemote('R');
    vi.advanceTimersByTime(1000);
    expect(bodies()).toEqual(['ABC']);
    save.ack(1, true);
    save.edited('AB');
    expect(reloads).toEqual([]);
  });

  it('a deferred body waits for an in-flight save; if that save fails, undoing loads the remote body', () => {
    const { save, reloads } = harness();
    save.loaded('A');
    save.edited('AB');
    vi.advanceTimersByTime(1000);
    save.deferRemote('R');
    save.edited('A');
    expect(reloads).toEqual([]);
    save.ack(1, false);
    expect(reloads).toEqual(['R']);
    expect(save.dirty).toBe(false);
  });
});
