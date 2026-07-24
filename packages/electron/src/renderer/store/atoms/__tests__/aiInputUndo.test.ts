import { describe, it, expect } from 'vitest';
import {
  applyClear,
  applyPush,
  applyRedo,
  applyUndo,
  COALESCE_WINDOW_MS,
  MAX_HISTORY,
  type AIInputHistory,
  type AIInputSnapshot,
} from '../aiInputUndo';

const EMPTY: AIInputHistory = {
  past: [],
  future: [],
  burstStartedAt: 0,
  undoCount: 0,
};

function snap(value: string, attachments: AIInputSnapshot['attachments'] = []): AIInputSnapshot {
  return { value, attachments, cursorStart: value.length, cursorEnd: value.length };
}

describe('aiInputUndo reducer', () => {
  describe('applyPush', () => {
    it('records the first typing snapshot', () => {
      const next = applyPush(EMPTY, snap(''), { now: 1000 });
      expect(next.past).toHaveLength(1);
      expect(next.past[0].value).toBe('');
      expect(next.burstStartedAt).toBe(1000);
    });

    it('coalesces rapid typing into a single entry', () => {
      let h = applyPush(EMPTY, snap(''), { now: 1000 });
      h = applyPush(h, snap('h'), { now: 1100 });
      h = applyPush(h, snap('hi'), { now: 1200 });
      h = applyPush(h, snap('his'), { now: 1300 });
      expect(h.past).toHaveLength(1);
      expect(h.past[0].value).toBe('');
      expect(h.burstStartedAt).toBe(1300);
    });

    it('records a new entry once the coalesce window has passed', () => {
      // Each push is the pre-edit snapshot for the upcoming keystroke.
      let h = applyPush(EMPTY, snap(''), { now: 1000 });   // pre-state for 'h' keystroke
      h = applyPush(h, snap('h'), { now: 1100 });          // pre-state for 'i' keystroke (in window, dropped)
      h = applyPush(h, snap('hi'), { now: 1100 + COALESCE_WINDOW_MS + 1 }); // new burst
      expect(h.past).toHaveLength(2);
      expect(h.past[0].value).toBe('');
      expect(h.past[1].value).toBe('hi');
    });

    it('boundary push always records and ends the typing burst', () => {
      let h = applyPush(EMPTY, snap(''), { now: 1000 });
      h = applyPush(h, snap('h'), { now: 1100 });
      // Boundary push during a burst always records.
      h = applyPush(h, snap('hi'), { now: 1200, boundary: true });
      expect(h.past).toHaveLength(2);
      expect(h.burstStartedAt).toBe(0);
      // Next typing push records as a new entry, not coalesced.
      h = applyPush(h, snap('hi!'), { now: 1250 });
      expect(h.past).toHaveLength(3);
    });

    it('clears future on any push', () => {
      const h0 = applyPush(EMPTY, snap('a'), { now: 1000, boundary: true });
      const { history: undone } = applyUndo(h0, snap('b'));
      expect(undone.future).toHaveLength(1);
      const after = applyPush(undone, snap('c'), { now: 2000, boundary: true });
      expect(after.future).toHaveLength(0);
    });

    it('caps the past stack at MAX_HISTORY', () => {
      let h: AIInputHistory = EMPTY;
      for (let i = 0; i < MAX_HISTORY + 25; i++) {
        h = applyPush(h, snap(`v${i}`), { now: i * 10000, boundary: true });
      }
      expect(h.past).toHaveLength(MAX_HISTORY);
      // Oldest entries dropped, newest preserved.
      expect(h.past[0].value).toBe(`v25`);
      expect(h.past[h.past.length - 1].value).toBe(`v${MAX_HISTORY + 24}`);
    });
  });

  describe('applyUndo / applyRedo', () => {
    it('undo returns the latest past snapshot and pushes current to future', () => {
      const h0 = applyPush(EMPTY, snap('a'), { now: 1000, boundary: true });
      const { history: h1, restored } = applyUndo(h0, snap('b'));
      expect(restored?.value).toBe('a');
      expect(h1.past).toHaveLength(0);
      expect(h1.future).toHaveLength(1);
      expect(h1.future[0].value).toBe('b');
    });

    it('redo round-trips back to the post-state', () => {
      const h0 = applyPush(EMPTY, snap('a'), { now: 1000, boundary: true });
      const { history: h1 } = applyUndo(h0, snap('b'));
      const { history: h2, restored } = applyRedo(h1, snap('a'));
      expect(restored?.value).toBe('b');
      expect(h2.future).toHaveLength(0);
      expect(h2.past).toHaveLength(1);
    });

    it('undo on empty history is a no-op and returns null', () => {
      const { history, restored } = applyUndo(EMPTY, snap('x'));
      expect(restored).toBeNull();
      expect(history).toBe(EMPTY);
    });

    it('redo on empty future is a no-op and returns null', () => {
      const h = applyPush(EMPTY, snap('a'), { now: 1000, boundary: true });
      const { history, restored } = applyRedo(h, snap('a'));
      expect(restored).toBeNull();
      expect(history).toBe(h);
    });

    it('undo increments undoCount; push and redo do not', () => {
      const h0 = applyPush(EMPTY, snap('a'), { now: 1000, boundary: true });
      expect(h0.undoCount).toBe(0);
      const { history: h1 } = applyUndo(h0, snap('b'));
      expect(h1.undoCount).toBe(1);
      const { history: h2 } = applyRedo(h1, snap('a'));
      expect(h2.undoCount).toBe(1);
      const h3 = applyPush(h2, snap('c'), { now: 2000, boundary: true });
      expect(h3.undoCount).toBe(1);
    });
  });

  describe('applyClear', () => {
    it('empties past and future', () => {
      let h = applyPush(EMPTY, snap('a'), { now: 1000, boundary: true });
      h = applyPush(h, snap('b'), { now: 2000, boundary: true });
      const { history: undone } = applyUndo(h, snap('c'));
      const cleared = applyClear(undone);
      expect(cleared.past).toHaveLength(0);
      expect(cleared.future).toHaveLength(0);
    });

    it('returns the same reference when already empty', () => {
      expect(applyClear(EMPTY)).toBe(EMPTY);
    });
  });
});
