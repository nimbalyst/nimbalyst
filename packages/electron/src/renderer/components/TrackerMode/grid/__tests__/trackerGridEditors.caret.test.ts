// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createTrackerCellEditor } from '../trackerGridEditors';

// Minimal stand-in for RevoGrid's hyperscript: build a real <input>, seed its
// value from the vnode's `value`, and hand the element to the `ref` callback so
// the editor captures it exactly as RevoGrid would at mount.
function mountTextEditor(editCell: unknown) {
  let input!: HTMLInputElement;
  const createElement = (tag: string, props: any) => {
    const el = document.createElement(tag) as HTMLInputElement;
    if (props?.value != null) el.value = String(props.value);
    if (typeof props?.ref === 'function') props.ref(el);
    if (tag === 'input') input = el;
    return el as unknown;
  };
  const factory = createTrackerCellEditor({ kind: 'text' } as any) as any;
  const editor = factory({}, () => {}, () => {});
  editor.editCell = editCell;
  const el = editor.render(createElement as any);
  document.body.appendChild(el as Node);
  return { editor, input };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('tracker text-cell editor caret placement (#1199)', () => {
  it('puts the caret at the end when the edit began from a keystroke (append, not replace)', async () => {
    // Keystroke edit: RevoGrid seeds `val` with the typed character while the
    // stored cell value is still empty. select() would highlight that character
    // so the next keystroke replaces it -> "Alpha" becomes "lpha".
    const { editor, input } = mountTextEditor({ val: 'A', prop: 'title', model: { title: '' } });
    await editor.componentDidRender();
    // Caret collapsed at the end, nothing selected -> the next keystroke appends.
    expect(input.value).toBe('A');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
  });

  it('selects the whole value when re-editing an existing cell (Enter/F2 -> type to replace)', async () => {
    // Enter/F2 edit: `val` still equals the stored value, so select-all is the
    // intended, preserved behavior (type replaces the whole cell).
    const { editor, input } = mountTextEditor({ val: 'Foo', prop: 'title', model: { title: 'Foo' } });
    await editor.componentDidRender();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });
});
