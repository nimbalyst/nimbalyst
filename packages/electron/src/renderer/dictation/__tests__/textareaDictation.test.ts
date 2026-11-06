// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyDictationText,
  clearDictationPartial,
  pendingRange,
} from '../textareaDictation';

describe('applyDictationText', () => {
  it('replaces the partial in place and commits the final at the same spot', () => {
    const value = 'fix the bug';
    const cursor = { start: 7, end: 7 }; // after "fix the"
    const p1 = applyDictationText(value, null, cursor, 'login', 'partial');
    expect(p1.value).toBe('fix the login bug');
    expect(pendingRange(p1.value, p1.state)).toEqual({ start: 7, end: 13 });

    const p2 = applyDictationText(p1.value, p1.state, cursor, 'logout', 'partial');
    expect(p2.value).toBe('fix the logout bug');

    const f = applyDictationText(p2.value, p2.state, cursor, 'logout flow', 'final');
    expect(f.value).toBe('fix the logout flow bug');
    expect(f.state.pending).toBe('');
    expect(f.cursor).toBe(19);
    expect(pendingRange(f.value, f.state)).toBeNull();
  });

  it('continues after a committed final when the next segment arrives', () => {
    const first = applyDictationText('', null, { start: 0, end: 0 }, 'hello', 'final');
    const second = applyDictationText(first.value, first.state, { start: first.cursor, end: first.cursor }, 'world', 'final');
    expect(second.value).toBe('hello world');
  });

  it('replaces a selected range', () => {
    const r = applyDictationText('use FOO here', null, { start: 4, end: 7 }, 'bar', 'final');
    expect(r.value).toBe('use bar here');
  });

  it('keeps text the user typed while a partial is showing', () => {
    const p = applyDictationText('ab', null, { start: 2, end: 2 }, 'speech', 'partial');
    expect(p.value).toBe('ab speech');
    // User types in front of the partial, shifting it right.
    const edited = 'xx' + p.value;
    const f = applyDictationText(edited, p.state, { start: 0, end: 0 }, 'speech done', 'final');
    expect(f.value).toBe('xxab speech done');
  });

  it('starts fresh at the cursor when the user deleted the partial', () => {
    const p = applyDictationText('ab', null, { start: 2, end: 2 }, 'gone', 'partial');
    const f = applyDictationText('ab', p.state, { start: 0, end: 0 }, 'new', 'final');
    expect(f.value).toBe('new ab');
  });
});

describe('clearDictationPartial (Esc)', () => {
  it('removes only the pending partial', () => {
    const p = applyDictationText('keep this', null, { start: 9, end: 9 }, 'discard me', 'partial');
    expect(p.value).toBe('keep this discard me');
    const cleared = clearDictationPartial(p.value, p.state);
    expect(cleared?.value).toBe('keep this');
    expect(cleared?.cursor).toBe(9);
  });

  it('is a no-op after a final committed', () => {
    const f = applyDictationText('', null, { start: 0, end: 0 }, 'kept', 'final');
    expect(clearDictationPartial(f.value, f.state)).toBeNull();
  });
});
