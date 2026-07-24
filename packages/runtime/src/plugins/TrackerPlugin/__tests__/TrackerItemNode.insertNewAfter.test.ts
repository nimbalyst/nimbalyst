/**
 * Regression test for issue #263.
 *
 * Pressing Enter at the end of a tracker-item line on the very last line of
 * a markdown file used to silently swallow the keypress, because Lexical's
 * default RichText KEY_ENTER_COMMAND handler delegates to the parent
 * ElementNode's `insertNewAfter` and the base implementation returns null.
 *
 * Mirror of HeadingNode/QuoteNode's pattern from `@lexical/rich-text`:
 * `insertNewAfter` should create and insert a new ParagraphNode below the
 * current tracker item so the cursor can land on a fresh empty line.
 */

import { describe, it, expect } from 'vitest';
import {
  createEditor,
  $getRoot,
  $createTextNode,
  $isParagraphNode,
} from 'lexical';

import {
  TrackerItemNode,
  $createTrackerItemNode,
  $isTrackerItemNode,
  type TrackerItemData,
} from '../TrackerItemNode';

function makeEditor() {
  // Headless Lexical editor with the tracker node registered.
  return createEditor({
    namespace: 'tracker-item-test',
    nodes: [TrackerItemNode],
    onError: (error: Error) => { throw error; },
  });
}

function makeTrackerData(overrides: Partial<TrackerItemData> = {}): TrackerItemData {
  return {
    id: 'test-tracker-1',
    type: 'task',
    title: 'Sample task',
    status: 'to-do',
    ...overrides,
  };
}

describe('TrackerItemNode.insertNewAfter (issue #263)', () => {
  it('inserts a ParagraphNode immediately after the tracker item', () => {
    const editor = makeEditor();
    let inserted: ReturnType<TrackerItemNode['insertNewAfter']> | null = null;

    editor.update(() => {
      const root = $getRoot();
      const tracker = $createTrackerItemNode(makeTrackerData());
      tracker.append($createTextNode('Sample task'));
      root.append(tracker);

      inserted = tracker.insertNewAfter(null);
    }, { discrete: true });

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(2);
      expect($isTrackerItemNode(children[0])).toBe(true);
      expect($isParagraphNode(children[1])).toBe(true);
      expect(inserted).not.toBeNull();
      expect($isParagraphNode(inserted as any)).toBe(true);
    });
  });

  it('returns the inserted paragraph so the caller can re-anchor selection', () => {
    const editor = makeEditor();
    let insertedKey: string | null = null;

    editor.update(() => {
      const root = $getRoot();
      const tracker = $createTrackerItemNode(makeTrackerData({ type: 'bug', title: 'Crash on Enter' }));
      tracker.append($createTextNode('Crash on Enter'));
      root.append(tracker);

      const newPara = tracker.insertNewAfter(null);
      insertedKey = newPara.getKey();
    }, { discrete: true });

    editor.read(() => {
      const children = $getRoot().getChildren();
      // The inserted paragraph must be the same instance, in position 1
      expect(children[1].getKey()).toBe(insertedKey);
    });
  });

  it('works for every tracker item type (task / bug / idea / plan / decision / automation)', () => {
    const types = ['task', 'bug', 'idea', 'plan', 'decision', 'automation'] as const;

    for (const type of types) {
      const editor = makeEditor();
      editor.update(() => {
        const root = $getRoot();
        const tracker = $createTrackerItemNode(makeTrackerData({ type, title: `Sample ${type}` }));
        tracker.append($createTextNode(`Sample ${type}`));
        root.append(tracker);

        tracker.insertNewAfter(null);
      }, { discrete: true });

      editor.read(() => {
        const children = $getRoot().getChildren();
        expect(children).toHaveLength(2);
        expect($isParagraphNode(children[1])).toBe(true);
      });
    }
  });

  it('preserves the direction (LTR/RTL) of the tracker item on the new paragraph', () => {
    const editor = makeEditor();

    editor.update(() => {
      const root = $getRoot();
      const tracker = $createTrackerItemNode(makeTrackerData());
      tracker.append($createTextNode('rtl content'));
      // Force RTL on the tracker item so the new paragraph should mirror it.
      tracker.setDirection('rtl');
      root.append(tracker);

      tracker.insertNewAfter(null);
    }, { discrete: true });

    editor.read(() => {
      const children = $getRoot().getChildren();
      const para = children[1];
      // ParagraphNode (an ElementNode) has getDirection on its prototype.
      // Narrow the type so TS is happy without weakening the test.
      if (!$isParagraphNode(para)) throw new Error('Expected a ParagraphNode below the tracker item');
      expect(para.getDirection()).toBe('rtl');
    });
  });
});
