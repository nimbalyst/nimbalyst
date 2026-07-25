/**
 * RevoGrid cell editors for the tracker grid, one per schema field type.
 *
 * Each editor is built as an `EditorCtrCallable` factory so the field's options
 * (select choices, relationship candidates, number bounds) are captured in a
 * closure -- RevoGrid hands the editor only the cell model, not our schema.
 *
 * Editors return the *raw* editor value; `coerceCellValue` in the runtime
 * package converts it to storage shape when the grid commits the edit.
 */

import type {
  EditorBase,
  EditorCtr,
  EditorCtrCallable,
  ColumnDataSchemaModel,
  EditCell,
  HyperFunc,
  VNode,
} from '@revolist/revogrid';
import type { CellEditorDescriptor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerCellEditors';

/** A tracker item the relationship editor can target. */
export interface RelationshipCandidate {
  itemId: string;
  issueKey?: string;
  title: string;
  trackerType: string;
}

export interface TrackerEditorContext {
  /** Candidates for relationship cells, narrowed by the field's target types. */
  relationshipCandidates?: () => RelationshipCandidate[];
}

/**
 * Shared key handling: Enter commits and advances one row, Tab/Shift+Tab commit
 * and let RevoGrid move horizontally, and Escape abandons the edit. Arrow keys
 * remain available to the active input/select instead of unexpectedly committing.
 */
export function commitOnNavigationKeys(
  e: KeyboardEvent,
  getValue: () => unknown,
  save: (value: unknown, preventFocus?: boolean) => void,
  close: (focusNext?: boolean) => void,
): void {
  const key = e.key;
  if (key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close(false);
    return;
  }
  if (key === 'Enter') {
    e.preventDefault();
    save(getValue(), false);
    return;
  }
  if (key === 'Tab') {
    save(getValue(), true);
  }
}

/** Text-like editor covering string, multiline, number, user, and url cells. */
function createInputEditor(
  descriptor: CellEditorDescriptor,
): EditorCtr {
  const inputType =
    descriptor.kind === 'number' ? 'number'
      : descriptor.kind === 'url' ? 'url'
        : 'text';

  return (_column, save, close): EditorBase => {
    let input: HTMLInputElement | null = null;
    const editor: EditorBase = {
      editCell: undefined as EditCell | undefined,
      getValue: () => input?.value ?? '',
      async componentDidRender() {
        // The input mounts inside RevoGrid's own render pass; yield a tick so
        // focus lands after the cell is actually in the DOM.
        await new Promise(resolve => setTimeout(resolve, 0));
        input?.focus();
        input?.select();
      },
      render(createElement: HyperFunc<VNode>) {
        return createElement('input', {
          type: inputType,
          class: 'tracker-grid-editor-input',
          min: descriptor.min,
          max: descriptor.max,
          value: editor.editCell?.val ?? '',
          ref: (el: HTMLInputElement | null) => { input = el; },
          onKeyDown: (e: KeyboardEvent) =>
            commitOnNavigationKeys(e, () => input?.value ?? '', save, close),
        });
      },
    };
    return editor;
  };
}

/** Dropdown editor for `select` fields; commits immediately on choice. */
function createSelectEditor(descriptor: CellEditorDescriptor): EditorCtr {
  return (_column, save, close): EditorBase => {
    let select: HTMLSelectElement | null = null;
    const options = descriptor.options ?? [];
    const editor: EditorBase = {
      editCell: undefined as EditCell | undefined,
      getValue: () => select?.value ?? '',
      async componentDidRender() {
        await new Promise(resolve => setTimeout(resolve, 0));
        select?.focus();
      },
      render(createElement: HyperFunc<VNode>) {
        const current = String(editor.editCell?.val ?? '');
        return createElement(
          'select',
          {
            class: 'tracker-grid-editor-select',
            ref: (el: HTMLSelectElement | null) => {
              if (!el) return;
              select = el;
              el.value = current;
            },
            // A dropdown has no separate "commit" gesture -- picking is committing.
            onChange: () => save(select?.value ?? '', false),
            onKeyDown: (e: KeyboardEvent) =>
              commitOnNavigationKeys(e, () => select?.value ?? '', save, close),
          },
          [
            // A blank choice is how a select cell gets cleared.
            createElement('option', { value: '' }, ''),
            ...options.map(opt => createElement('option', { value: opt.value }, opt.label)),
          ],
        );
      },
    };
    return editor;
  };
}

/**
 * Multi-value editor. Values are typed as comma-separated text and a datalist
 * offers the known options; `coerceCellValue` splits the text back into an array.
 */
function createMultiselectEditor(descriptor: CellEditorDescriptor): EditorCtr {
  return (column, save, close): EditorBase => {
    let input: HTMLInputElement | null = null;
    const options = descriptor.options ?? [];
    const listId = `tracker-grid-tags-${String(column.prop)}`;
    const editor: EditorBase = {
      editCell: undefined as EditCell | undefined,
      getValue: () => input?.value ?? '',
      async componentDidRender() {
        await new Promise(resolve => setTimeout(resolve, 0));
        input?.focus();
        input?.select();
      },
      render(createElement: HyperFunc<VNode>) {
        const raw = editor.editCell?.val;
        const seed = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
        return [
          createElement('input', {
            type: 'text',
            class: 'tracker-grid-editor-input',
            list: options.length > 0 ? listId : undefined,
            value: seed,
            ref: (el: HTMLInputElement | null) => { input = el; },
            onKeyDown: (e: KeyboardEvent) =>
              commitOnNavigationKeys(e, () => input?.value ?? '', save, close),
          }),
          ...(options.length > 0
            ? [createElement(
              'datalist',
              { id: listId },
              options.map(opt => createElement('option', { value: opt.value }, opt.label)),
            )]
            : []),
        ];
      },
    };
    return editor;
  };
}

/** Native date / datetime-local picker. */
function createDateEditor(descriptor: CellEditorDescriptor): EditorCtr {
  const inputType = descriptor.kind === 'datetime' ? 'datetime-local' : 'date';

  return (_column, save, close): EditorBase => {
    let input: HTMLInputElement | null = null;
    const editor: EditorBase = {
      editCell: undefined as EditCell | undefined,
      getValue: () => input?.value ?? '',
      async componentDidRender() {
        await new Promise(resolve => setTimeout(resolve, 0));
        input?.focus();
      },
      render(createElement: HyperFunc<VNode>) {
        const raw = editor.editCell?.val;
        // `datetime-local` rejects a trailing Z, so trim an ISO string to minutes.
        const seed = raw == null || raw === ''
          ? ''
          : inputType === 'date'
            ? String(raw).slice(0, 10)
            : String(raw).slice(0, 16);
        return createElement('input', {
          type: inputType,
          class: 'tracker-grid-editor-input',
          value: seed,
          ref: (el: HTMLInputElement | null) => { input = el; },
          onKeyDown: (e: KeyboardEvent) =>
            commitOnNavigationKeys(e, () => input?.value ?? '', save, close),
        });
      },
    };
    return editor;
  };
}

/** Checkbox editor; toggling commits immediately. */
function createBooleanEditor(): EditorCtr {
  return (_column, save, close): EditorBase => {
    let input: HTMLInputElement | null = null;
    const editor: EditorBase = {
      editCell: undefined as EditCell | undefined,
      getValue: () => input?.checked ?? false,
      async componentDidRender() {
        await new Promise(resolve => setTimeout(resolve, 0));
        input?.focus();
      },
      render(createElement: HyperFunc<VNode>) {
        const raw = editor.editCell?.val;
        const checked = raw === true || raw === 'true';
        return createElement('input', {
          type: 'checkbox',
          class: 'tracker-grid-editor-checkbox',
          checked,
          ref: (el: HTMLInputElement | null) => { input = el; },
          onChange: () => save(input?.checked ?? false, false),
          onKeyDown: (e: KeyboardEvent) =>
            commitOnNavigationKeys(e, () => input?.checked ?? false, save, close),
        });
      },
    };
    return editor;
  };
}

/**
 * Relationship picker. Candidates render as `KEY -- Title` in a datalist; the
 * typed text is mapped back to item ids on commit so the grid stores real
 * relationship values rather than free text.
 */
function createRelationshipEditor(
  descriptor: CellEditorDescriptor,
  context: TrackerEditorContext,
): EditorCtr {
  return (column, save, close): EditorBase => {
    let input: HTMLInputElement | null = null;
    const listId = `tracker-grid-rel-${String(column.prop)}`;

    const candidates = (): RelationshipCandidate[] => {
      const all = context.relationshipCandidates?.() ?? [];
      const targets = descriptor.targetTrackerTypes;
      if (!targets || targets === '*') return all;
      return all.filter(c => targets.includes(c.trackerType));
    };

    const labelFor = (c: RelationshipCandidate): string =>
      c.issueKey ? `${c.issueKey} -- ${c.title}` : c.title;

    /** Map the typed labels back to item ids, dropping anything unrecognized. */
    const resolveIds = (): string[] => {
      const text = input?.value ?? '';
      if (!text.trim()) return [];
      const byLabel = new Map(candidates().map(c => [labelFor(c), c.itemId]));
      const byKey = new Map(
        candidates().filter(c => c.issueKey).map(c => [c.issueKey as string, c.itemId]),
      );
      return text
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => byLabel.get(part) ?? byKey.get(part))
        .filter((id): id is string => Boolean(id));
    };

    const editor: EditorBase = {
      editCell: undefined as EditCell | undefined,
      getValue: resolveIds,
      async componentDidRender() {
        await new Promise(resolve => setTimeout(resolve, 0));
        input?.focus();
        input?.select();
      },
      render(createElement: HyperFunc<VNode>) {
        const raw = editor.editCell?.val;
        const existing = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const byId = new Map(candidates().map(c => [c.itemId, c]));
        const seed = existing
          .map((v: any) => {
            const id = typeof v === 'string' ? v : v?.itemId;
            const candidate = id ? byId.get(id) : undefined;
            return candidate ? labelFor(candidate) : (v?.issueKey ?? v?.title ?? '');
          })
          .filter(Boolean)
          .join(', ');

        return [
          createElement('input', {
            type: 'text',
            class: 'tracker-grid-editor-input',
            list: listId,
            placeholder: descriptor.multiValue ? 'Comma-separated items' : 'Pick an item',
            value: seed,
            ref: (el: HTMLInputElement | null) => { input = el; },
            onKeyDown: (e: KeyboardEvent) => commitOnNavigationKeys(e, resolveIds, save, close),
          }),
          createElement(
            'datalist',
            { id: listId },
            candidates().slice(0, 200).map(c =>
              createElement('option', { value: labelFor(c) }, labelFor(c))),
          ),
        ];
      },
    };
    return editor;
  };
}

/**
 * Build the RevoGrid editor for a resolved cell-editor descriptor.
 * Returns `undefined` for readonly cells so RevoGrid never enters edit mode.
 */
export function createTrackerCellEditor(
  descriptor: CellEditorDescriptor,
  context: TrackerEditorContext = {},
): EditorCtr | undefined {
  switch (descriptor.kind) {
    case 'readonly':
      return undefined;
    case 'select':
      return createSelectEditor(descriptor);
    case 'multiselect':
      return createMultiselectEditor(descriptor);
    case 'date':
    case 'datetime':
      return createDateEditor(descriptor);
    case 'boolean':
      return createBooleanEditor();
    case 'relationship':
      return createRelationshipEditor(descriptor, context);
    case 'text':
    case 'multiline':
    case 'number':
    case 'user':
    case 'url':
    default:
      return createInputEditor(descriptor);
  }
}

/**
 * Resolve an editor from the row being edited. Mixed-type grids cannot choose a
 * single schema descriptor at column-construction time, because the same role
 * may map to differently named fields and option sets on each row.
 */
export function createRowAwareTrackerCellEditor(
  resolveDescriptor: (editCell: EditCell | undefined) => CellEditorDescriptor,
  context: TrackerEditorContext = {},
): EditorCtr {
  return (column, save, close): EditorBase => {
    let activeEditor: EditorBase | undefined;
    const editor: EditorBase = {
      editCell: undefined,
      getValue: () => activeEditor?.getValue?.(),
      async componentDidRender() {
        await activeEditor?.componentDidRender?.();
      },
      render(createElement: HyperFunc<VNode>) {
        const descriptor = resolveDescriptor(editor.editCell);
        const editorFactory = createTrackerCellEditor(descriptor, context);
        if (!editorFactory) {
          activeEditor = undefined;
          return createElement('span', {}, '');
        }
        const resolvedEditor = (editorFactory as EditorCtrCallable)(column, save, close);
        resolvedEditor.editCell = editor.editCell;
        activeEditor = resolvedEditor;
        return resolvedEditor.render(createElement);
      },
    };
    return editor;
  };
}
