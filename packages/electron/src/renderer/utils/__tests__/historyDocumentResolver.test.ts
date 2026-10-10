// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveHistoryDocumentPath } from '../historyDocumentResolver';

describe('resolveHistoryDocumentPath', () => {
  it('uses the focused collaborative document instead of a stale local path', () => {
    expect(resolveHistoryDocumentPath({
      activeMode: 'collab',
      localDocumentPath: '/workspace/previous-local.md',
      collabDocumentPath: 'collab://org-a/doc-a',
    })).toBe('collab://org-a/doc-a');
  });

  // A Personal page tab is `personal://<id>`; its history is keyed by document.
  it('opens a Personal page tab under its local history key', () => {
    expect(resolveHistoryDocumentPath({
      activeMode: 'collab',
      collabDocumentPath: 'personal://pdoc-1',
    })).toBe('personal-doc://pdoc-1');
  });

  it('does not fall back to a local document when collab mode has no active tab', () => {
    expect(resolveHistoryDocumentPath({
      activeMode: 'collab',
      localDocumentPath: '/workspace/previous-local.md',
      collabDocumentPath: null,
    })).toBeNull();
  });

  it.each(['files', 'agent'] as const)(
    'preserves the current local document path in %s mode',
    (activeMode) => {
      expect(resolveHistoryDocumentPath({
        activeMode,
        localDocumentPath: '/workspace/current.md',
        collabDocumentPath: 'collab://org-a/doc-a',
      })).toBe('/workspace/current.md');
    },
  );
});
