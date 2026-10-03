// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createTrackerCellEditor, shouldSelectAllOnEdit } from '../grid/trackerGridEditors';

// Minimal stand-in for RevoGrid's hyperscript: build a real <input>, seed its
// value from the vnode's `value`, and hand the element to the `ref` callback so
// the editor captures it exactly as RevoGrid would at mount.
function mountTextEditor(editCell: unknown, kind = 'text') {
  let input!: HTMLInputElement;
  const createElement = (tag: string, props: any) => {
    const el = document.createElement(tag) as HTMLInputElement;
    if (props?.value != null) el.value = String(props.value);
    if (typeof props?.ref === 'function') props.ref(el);
    if (tag === 'input') input = el;
    return el as unknown;
  };
  const factory = createTrackerCellEditor({ kind } as any) as any;
  const editor = factory({}, () => {}, () => {});
  editor.editCell = editCell;
  const el = editor.render(createElement as any);
  document.body.appendChild(el as Node);
  return { editor, input };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('shouldSelectAllOnEdit (#1199)', () => {
  it('does not select-all when the edit began from a keystroke', () => {
    // RevoGrid seeds `val` with the typed character while the model still
    // holds the original value.
    expect(shouldSelectAllOnEdit({ val: 'A', prop: 'title', model: { title: '' } } as any))
      .toBe(false);
    expect(shouldSelectAllOnEdit({ val: 'X', prop: 'title', model: { title: 'Foo' } } as any))
      .toBe(false);
  });

  it('selects all when re-editing an unchanged cell (Enter / F2)', () => {
    expect(shouldSelectAllOnEdit({ val: 'Foo', prop: 'title', model: { title: 'Foo' } } as any))
      .toBe(true);
    expect(shouldSelectAllOnEdit({ val: '', prop: 'title', model: { title: '' } } as any))
      .toBe(true);
  });

  it('treats a null/undefined stored value as empty rather than as a difference', () => {
    // An unset field opened with Enter must still select-all, not fall through
    // to the keystroke branch on a null-vs-empty-string mismatch.
    expect(shouldSelectAllOnEdit({ val: '', prop: 'title', model: { title: null } } as any))
      .toBe(true);
    expect(shouldSelectAllOnEdit({ val: '', prop: 'title', model: {} } as any))
      .toBe(true);
  });

  it('compares by rendered text, so a numeric cell is not a false keystroke', () => {
    // Number cells arrive as a number in the model and a string in `val`.
    expect(shouldSelectAllOnEdit({ val: '42', prop: 'points', model: { points: 42 } } as any))
      .toBe(true);
  });

  it('selects all when there is no edit cell to compare', () => {
    expect(shouldSelectAllOnEdit(undefined)).toBe(true);
  });
});

describe('tracker text-cell editor caret placement (#1199)', () => {
  it('puts the caret at the end when the edit began from a keystroke (append, not replace)', async () => {
    // Keystroke edit: select() would highlight the character the user just
    // typed, so the next keystroke replaces it -- "Alpha" arrives as "lpha".
    const { editor, input } = mountTextEditor({ val: 'A', prop: 'title', model: { title: '' } });
    await editor.componentDidRender();
    // Caret collapsed at the end, nothing selected -> the next keystroke appends.
    expect(input.value).toBe('A');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
  });

  it('selects the whole value when re-editing an existing cell (Enter/F2 -> type to replace)', async () => {
    const { editor, input } = mountTextEditor({ val: 'Foo', prop: 'title', model: { title: 'Foo' } });
    await editor.componentDidRender();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  it('survives an input type that rejects setSelectionRange', async () => {
    // jsdom throws InvalidStateError for `number` inputs, as browsers do. The
    // editor must still mount and keep the typed character.
    const { editor, input } = mountTextEditor(
      { val: '4', prop: 'points', model: { points: 7 } },
      'number',
    );
    await expect(editor.componentDidRender()).resolves.not.toThrow();
    expect(input.value).toBe('4');
  });
});
