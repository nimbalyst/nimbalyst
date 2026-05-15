import { describe, expect, it } from 'vitest';
import { reverseCodexPatch } from '../patchReverse';

describe('reverseCodexPatch', () => {
  describe('add kind', () => {
    it('returns null pre-edit content (file did not exist)', () => {
      const result = reverseCodexPatch('apple\nbanana\ncherry\n', null, 'add');
      expect(result).toEqual({ ok: true, preEditContent: null });
    });

    it('returns null even when post-edit content is provided', () => {
      const result = reverseCodexPatch('whatever\n', 'whatever\n', 'add');
      expect(result).toEqual({ ok: true, preEditContent: null });
    });
  });

  describe('delete kind', () => {
    it('strips leading - from each line', () => {
      const diff = '-one\n-two\n-three\n';
      const result = reverseCodexPatch(diff, null, 'delete');
      expect(result).toEqual({ ok: true, preEditContent: 'one\ntwo\nthree\n' });
    });

    it('preserves absence of trailing newline', () => {
      const diff = '-one\n-two\n-three';
      const result = reverseCodexPatch(diff, null, 'delete');
      expect(result).toEqual({ ok: true, preEditContent: 'one\ntwo\nthree' });
    });

    it('passes through lines without - prefix defensively', () => {
      const diff = '-one\ncontext\n-three\n';
      const result = reverseCodexPatch(diff, null, 'delete');
      expect(result).toEqual({ ok: true, preEditContent: 'one\ncontext\nthree\n' });
    });
  });

  describe('update kind - single hunk', () => {
    // The canonical example we observed in the Phase 0 spike: changing "two" to "TWO".
    it('reverses the spike example exactly', () => {
      const diff = '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n';
      const postEdit = 'one\nTWO\nthree\n';
      const result = reverseCodexPatch(diff, postEdit, 'update');
      expect(result).toEqual({ ok: true, preEditContent: 'one\ntwo\nthree\n' });
    });

    it('reverses an insertion at top of file', () => {
      const diff = '@@ -1,2 +1,3 @@\n+new first line\n line one\n line two\n';
      const postEdit = 'new first line\nline one\nline two\n';
      const result = reverseCodexPatch(diff, postEdit, 'update');
      expect(result).toEqual({ ok: true, preEditContent: 'line one\nline two\n' });
    });

    it('reverses a deletion in middle of file', () => {
      const diff = '@@ -1,4 +1,3 @@\n alpha\n beta\n-gamma\n delta\n';
      const postEdit = 'alpha\nbeta\ndelta\n';
      const result = reverseCodexPatch(diff, postEdit, 'update');
      expect(result).toEqual({ ok: true, preEditContent: 'alpha\nbeta\ngamma\ndelta\n' });
    });
  });

  describe('update kind - multi-hunk', () => {
    it('reverses two hunks affecting different parts of the file', () => {
      const diff =
        '@@ -1,3 +1,3 @@\n alpha\n-old1\n+new1\n gamma\n' +
        '@@ -7,3 +7,3 @@\n eta\n-old2\n+new2\n iota\n';
      const postEdit = 'alpha\nnew1\ngamma\ndelta\nepsilon\nzeta\neta\nnew2\niota\n';
      const result = reverseCodexPatch(diff, postEdit, 'update');
      expect(result).toEqual({
        ok: true,
        preEditContent: 'alpha\nold1\ngamma\ndelta\nepsilon\nzeta\neta\nold2\niota\n',
      });
    });
  });

  describe('update kind - trailing newline handling', () => {
    it('preserves the absence of trailing newline', () => {
      const diff = '@@ -1,2 +1,2 @@\n one\n-two\n+TWO';
      const postEdit = 'one\nTWO';
      const result = reverseCodexPatch(diff, postEdit, 'update');
      expect(result).toEqual({ ok: true, preEditContent: 'one\ntwo' });
    });
  });

  describe('update kind - error cases', () => {
    it('errors when post-edit content is missing', () => {
      const diff = '@@ -1,1 +1,1 @@\n-a\n+b\n';
      const result = reverseCodexPatch(diff, null, 'update');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('post-edit content');
    });

    it('errors when no hunk headers are present', () => {
      const result = reverseCodexPatch('just some text\n', 'just some text\n', 'update');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('no hunk headers');
    });
  });

  describe('unknown kind', () => {
    it('errors on unknown kind', () => {
      // @ts-expect-error -- exercising defensive branch
      const result = reverseCodexPatch('whatever', null, 'rename');
      expect(result.ok).toBe(false);
    });
  });
});
