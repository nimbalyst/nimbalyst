import { describe, expect, it } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createListItemNode,
  $createListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $setSelection,
  type LexicalEditor,
  type RangeSelection,
} from 'lexical';
import { $clearFormatForListItemEnter } from '../index';

// Regression coverage for nimbalyst#302. When the cursor sits at end-of-line
// after a space that follows an inline-code text node inside a list item,
// pressing Enter creates a new bullet still in inline-code format because
// Lexical carries selection.format forward. The plugin clears the format
// before INSERT_PARAGRAPH_COMMAND runs.
//
// These tests exercise the pure decision/mutation function rather than the
// React plugin shell so they can run under createHeadlessEditor without
// mounting a React tree.

const IS_BOLD = 1;
const IS_ITALIC = 1 << 1;
const IS_CODE = 1 << 4;

function withEditor<T>(fn: (editor: LexicalEditor) => T): T {
  const editor = createHeadlessEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error;
    },
  });
  let result: T;
  editor.update(
    () => {
      result = fn(editor);
    },
    { discrete: true },
  );
  return result!;
}

/**
 * Build a list-item containing a single text node, place the cursor at
 * `cursorOffset` inside that text node, seed selection.format, then run the
 * gate. Returns the post-gate selection.format and the boolean return.
 */
function runGate(args: {
  text: string;
  format: number;
  cursorOffset: number;
}): { didClear: boolean; postFormat: number } {
  return withEditor(() => {
    const root = $getRoot();
    root.clear();
    const list = $createListNode('bullet');
    const item = $createListItemNode();
    const tn = $createTextNode(args.text);
    tn.setFormat(args.format);
    item.append(tn);
    list.append(item);
    root.append(list);

    const sel = $createRangeSelection();
    sel.anchor.set(tn.getKey(), args.cursorOffset, 'text');
    sel.focus.set(tn.getKey(), args.cursorOffset, 'text');
    sel.format = args.format;
    $setSelection(sel);

    const live = $createRangeSelection();
    live.anchor.set(tn.getKey(), args.cursorOffset, 'text');
    live.focus.set(tn.getKey(), args.cursorOffset, 'text');
    live.format = args.format;
    const didClear = $clearFormatForListItemEnter(live);
    return { didClear, postFormat: live.format };
  });
}

describe('$clearFormatForListItemEnter (issue #302)', () => {
  describe('clears format on trailing-whitespace-after-code', () => {
    it('clears IS_CODE when cursor is right after a space following code', () => {
      // "code " -> cursor at offset 5 (end), prev char is a regular space.
      // selection.format still carries the code bit. The gate should clear it.
      const { didClear, postFormat } = runGate({
        text: 'code ',
        format: IS_CODE,
        cursorOffset: 5,
      });
      expect(didClear).toBe(true);
      expect(postFormat).toBe(0);
    });

    it('clears IS_BOLD on the same trailing-space pattern (symmetry check)', () => {
      // The mechanism is not code-specific. Bold and italic carry the same
      // way; the fix clears all formats on trailing whitespace so the new
      // list item starts plain.
      const { didClear, postFormat } = runGate({
        text: 'bold ',
        format: IS_BOLD,
        cursorOffset: 5,
      });
      expect(didClear).toBe(true);
      expect(postFormat).toBe(0);
    });

    it('also clears on a tab character', () => {
      const { didClear, postFormat } = runGate({
        text: 'code\t',
        format: IS_CODE,
        cursorOffset: 5,
      });
      expect(didClear).toBe(true);
      expect(postFormat).toBe(0);
    });

    it('also clears on a non-breaking space (U+00A0)', () => {
      const { didClear, postFormat } = runGate({
        text: 'code ',
        format: IS_CODE,
        cursorOffset: 5,
      });
      expect(didClear).toBe(true);
      expect(postFormat).toBe(0);
    });
  });

  describe('does NOT clear when cursor is inside the formatted span', () => {
    it('leaves IS_CODE alone when cursor is right after code, no trailing space', () => {
      // "code" -> cursor at offset 4 (end of text, no trailing space).
      // User is still inside the code span; the new line should keep the
      // code style if they press Enter here. Our gate must not interfere.
      const { didClear, postFormat } = runGate({
        text: 'code',
        format: IS_CODE,
        cursorOffset: 4,
      });
      expect(didClear).toBe(false);
      expect(postFormat).toBe(IS_CODE);
    });

    it('leaves format alone when cursor is at offset 0', () => {
      // Cursor at start of a code text node. No char before to inspect.
      const { didClear, postFormat } = runGate({
        text: 'code',
        format: IS_CODE,
        cursorOffset: 0,
      });
      expect(didClear).toBe(false);
      expect(postFormat).toBe(IS_CODE);
    });

    it('leaves format alone when the previous char is not whitespace', () => {
      // "codex" -> cursor at offset 5 (end). Prev char "x" is not whitespace.
      const { didClear, postFormat } = runGate({
        text: 'codex',
        format: IS_CODE,
        cursorOffset: 5,
      });
      expect(didClear).toBe(false);
      expect(postFormat).toBe(IS_CODE);
    });
  });

  describe('does NOT clear when selection.format is already 0', () => {
    it('returns false fast when format is 0', () => {
      const { didClear, postFormat } = runGate({
        text: 'plain ',
        format: 0,
        cursorOffset: 6,
      });
      expect(didClear).toBe(false);
      expect(postFormat).toBe(0);
    });
  });

  describe('does NOT clear outside a list item', () => {
    it('returns false when cursor is inside a paragraph (not a list item)', () => {
      // Build a paragraph instead of a list item. The same trailing-space
      // condition should be ignored because the bug report and the fix are
      // scoped to list items per #302. Broaden later if maintainers ask.
      const got = withEditor(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        const tn = $createTextNode('code ');
        tn.setFormat(IS_CODE);
        p.append(tn);
        root.append(p);

        const sel = $createRangeSelection();
        sel.anchor.set(tn.getKey(), 5, 'text');
        sel.focus.set(tn.getKey(), 5, 'text');
        sel.format = IS_CODE;
        const didClear = $clearFormatForListItemEnter(sel);
        return { didClear, postFormat: sel.format };
      });
      expect(got.didClear).toBe(false);
      expect(got.postFormat).toBe(IS_CODE);
    });
  });

  describe('does NOT clear on non-collapsed selection', () => {
    it('returns false when selection has a range (anchor != focus)', () => {
      // Avoid touching format mid-range-edit. The bug is about end-of-line
      // Enter; range-selection Enter has different semantics.
      const got = withEditor(() => {
        const root = $getRoot();
        root.clear();
        const list = $createListNode('bullet');
        const item = $createListItemNode();
        const tn = $createTextNode('code  ');
        tn.setFormat(IS_CODE);
        item.append(tn);
        list.append(item);
        root.append(list);

        const sel = $createRangeSelection();
        sel.anchor.set(tn.getKey(), 4, 'text');
        sel.focus.set(tn.getKey(), 6, 'text');
        sel.format = IS_CODE;
        const didClear = $clearFormatForListItemEnter(sel);
        return { didClear, postFormat: sel.format };
      });
      expect(got.didClear).toBe(false);
      expect(got.postFormat).toBe(IS_CODE);
    });
  });

  describe('combined formats', () => {
    it('clears bold+code together on trailing-space', () => {
      const combined = IS_BOLD | IS_CODE;
      const { didClear, postFormat } = runGate({
        text: 'mix ',
        format: combined,
        cursorOffset: 4,
      });
      expect(didClear).toBe(true);
      expect(postFormat).toBe(0);
    });
  });
});
