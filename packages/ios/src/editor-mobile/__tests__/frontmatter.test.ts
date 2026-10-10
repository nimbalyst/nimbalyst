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
  });

  it('treats text without a closed block as all body', () => {
    expect(splitFrontmatter('# No frontmatter\n')).toEqual({ prefix: '', body: '# No frontmatter\n' });
    expect(splitFrontmatter('---\nid: x\nno close\n')).toEqual({ prefix: '', body: '---\nid: x\nno close\n' });
  });
});

describe('mobile editor pending save', () => {
  function setup() {
    const saves: Array<[number, string]> = [];
    const dirty: boolean[] = [];
    const reloads: string[] = [];
    const save = new PendingSave({
      onSave: (revision, body) => saves.push([revision, body]),
      onDirty: (d) => dirty.push(d),
      onReload: (b) => reloads.push(b),
    });
    return { save, saves, dirty, reloads };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an undo inside the debounce cancels the save of the undone text', () => {
    const { save, saves, dirty } = setup();
    save.loaded('A');
    save.edited('AB');
    save.edited('A');
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual([]);
    expect(dirty).toEqual([true, false]);
  });

  it('a failed save stays dirty without retrying; undo is clean and redo saves again', () => {
    const { save, saves, dirty } = setup();
    save.loaded('A');
    save.edited('AB');
    vi.advanceTimersByTime(600);
    expect(saves).toEqual([[1, 'AB']]);
    save.ack(1, false);
    vi.advanceTimersByTime(5000);
    expect(saves).toHaveLength(1);
    expect(save.dirty).toBe(true);
    save.edited('A');
    expect(save.dirty).toBe(false);
    save.edited('AB');
    vi.advanceTimersByTime(600);
    expect(saves).toEqual([[1, 'AB'], [2, 'AB']]);
    save.ack(2, true);
    expect(save.confirmed).toBe('AB');
    expect(dirty.at(-1)).toBe(false);
  });

  it('typing during a save waits for its ack, then saves the newer body', () => {
    const { save, saves } = setup();
    save.loaded('A');
    save.edited('AB');
    vi.advanceTimersByTime(600);
    save.edited('ABC');
    vi.advanceTimersByTime(5000);
    expect(saves).toEqual([[1, 'AB']]);
    save.ack(1, true);
    vi.advanceTimersByTime(600);
    expect(saves).toEqual([[1, 'AB'], [2, 'ABC']]);
    save.ack(2, true);
    expect(save.dirty).toBe(false);
  });

  it('an undo back to confirmed during a save is decided by the ack', () => {
    const { save, saves } = setup();
    save.loaded('A');
    save.edited('AB');
    vi.advanceTimersByTime(600);
    save.edited('A');
    expect(save.dirty).toBe(true);
    save.ack(1, true);
    vi.advanceTimersByTime(600);
    expect(saves).toEqual([[1, 'AB'], [2, 'A']]);
  });

  it('undoing edits after a deferred remote body loads that body', () => {
    const { save, saves, reloads } = setup();
    save.loaded('A');
    save.edited('AB');
    save.deferRemote('REMOTE');
    save.edited('A');
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual([]);
    expect(reloads).toEqual(['REMOTE']);
    save.loaded('REMOTE');
    save.edited('REMOTE!');
    save.edited('REMOTE');
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual([]);
    expect(save.dirty).toBe(false);
  });

  it('typing the deferred text is clean; a persisted local save supersedes a deferred body', () => {
    const { save, saves, reloads } = setup();
    save.loaded('A');
    save.edited('AB');
    save.deferRemote('AB');
    save.edited('AB');
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual([]);
    expect(save.dirty).toBe(false);

    save.edited('ABC');
    vi.advanceTimersByTime(600);
    save.deferRemote('R');
    save.ack(1, true);
    save.edited('AB');
    expect(reloads).toEqual([]);
  });

  it('a flush saves now; while a save is in flight the final body is still available', () => {
    const { save, saves } = setup();
    save.loaded('A');
    save.flush();
    expect(saves).toEqual([]);
    expect(save.finalBody()).toBeNull();
    save.edited('AB');
    save.flush();
    expect(saves).toEqual([[1, 'AB']]);
    save.edited('ABC');
    save.flush();
    expect(saves).toHaveLength(1);
    expect(save.finalBody()).toBe('ABC');
    save.ack(1, true);
    expect(saves).toEqual([[1, 'AB'], [2, 'ABC']]);
  });
});
