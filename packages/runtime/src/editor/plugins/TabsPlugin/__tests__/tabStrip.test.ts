/**
 * The tabs block against the live editor: the full extension transformer set
 * (where the collapsible transformer also reads `<details>`), and the tab
 * strip's DOM with edits arriving while the user is mid-gesture.
 */
import { buildEditorFromExtensions } from '@lexical/extension';
import { $getRoot, type Klass, type LexicalEditor, type LexicalNode } from 'lexical';
import { afterEach, describe, expect, it } from 'vitest';

import { buildNimbalystRootExtension } from '../../../extensions/NimbalystEditorExtensions';
import '../../../extensions/registerBuiltinExtensions';
import { getEditorTransformers } from '../../../markdown';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { fenceRoundTrip } from '../../fencedBlock/__tests__/fenceRoundTrip';
import { draggableBlockMenuRegistry } from '../../DraggableBlockPlugin/DraggableBlockMenuRegistry';
import { $addTab, $isTabsNode, TabPanelNode } from '../TabsNodes';

const MALFORMED = [
  '<div data-tabs>',
  '<details data-tab>',
  '',
  'BEFORE_NESTED',
  '',
  '<div data-tabs>',
  '<details data-tab>',
  '<summary>Inner</summary>',
  '',
  'INNER_BODY',
  '',
  '</details>',
  '</div>',
  '',
  '</details>',
  '</div>',
].join('\n');

function liveEditor(): LexicalEditor {
  return buildEditorFromExtensions(buildNimbalystRootExtension({ editable: true }));
}

describe('a tab panel without a summary', () => {
  it.each([
    ['live', () => ({ nodes: [...liveEditor()._nodes.values()].map((entry) => entry.klass as Klass<LexicalNode>), transformers: getEditorTransformers() })],
    ['headless', () => ({ nodes: HeadlessBodyNodes, transformers: undefined })],
  ])('loses nothing with the %s transformer set', (_name, setup) => {
    const { nodes, transformers } = setup();
    const trip = fenceRoundTrip(MALFORMED, { nodes, ...(transformers ? { transformers } : {}) });
    expect(trip.errors).toEqual([]);
    for (const text of ['BEFORE_NESTED', 'INNER_BODY', '<summary>Inner</summary>']) {
      expect(trip.exported).toContain(text);
    }
    // Both opening tags of the nested block survive as well as the outer ones.
    expect(trip.exported.match(/<details data-tab>/g)).toHaveLength(2);
    expect(trip.exported.match(/<div data-tabs>/g)).toHaveLength(2);
  });
});

const TWO_TABS = [
  '<div data-tabs>',
  '<details data-tab>', '<summary>One</summary>', '', 'first', '', '</details>',
  '<details data-tab>', '<summary>Two</summary>', '', 'second', '', '</details>',
  '<details data-tab>', '<summary>Three</summary>', '', 'third', '', '</details>',
  '</div>',
].join('\n');

let mounted: { editor: LexicalEditor; root: HTMLElement } | null = null;

afterEach(() => {
  mounted?.editor.setRootElement(null);
  mounted?.root.remove();
  mounted = null;
});

function mount(): { editor: LexicalEditor; strip: () => HTMLElement } {
  const editor = liveEditor();
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  editor.setRootElement(root);
  editor.update(() => { $convertFromEnhancedMarkdownString(TWO_TABS, getEditorTransformers(), undefined, true, false); }, { discrete: true });
  mounted = { editor, root };
  return { editor, strip: () => root.querySelector<HTMLElement>('.tabs-strip')! };
}

function panelNames(editor: LexicalEditor): string[] {
  return editor.getEditorState().read(() => $getRoot().getChildren().find($isTabsNode)!.getPanels().map((panel) => panel.getName()));
}

/** The strip's own edits commit on the next microtask, like any `editor.update`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function update(editor: LexicalEditor, fn: () => void): void {
  editor.update(fn, { discrete: true });
}

describe('tab strip', () => {
  it('keeps an unfinished rename, its input and focus, through a teammate\'s edit', async () => {
    const { editor, strip } = mount();
    const tab = [...strip().querySelectorAll<HTMLElement>('[data-testid="tabs-strip-tab"]')].find((el) => el.textContent === 'Two')!;
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = strip().querySelector<HTMLInputElement>('[data-testid="tabs-strip-rename"]')!;
    input.focus();
    input.value = 'Second draf';

    // A remote insert and a remote rename of another tab.
    update(editor, () => {
      const tabs = $getRoot().getChildren().find($isTabsNode)!;
      $addTab(tabs, 'Remote');
      tabs.getPanels()[0].setName('Uno');
    });

    expect(strip().querySelector('[data-testid="tabs-strip-rename"]')).toBe(input);
    expect(input.value).toBe('Second draf');
    expect(document.activeElement).toBe(input);
    expect(panelNames(editor)).toEqual(['Uno', 'Two', 'Three', 'Remote']);

    input.value = 'Second';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(panelNames(editor)).toEqual(['Uno', 'Second', 'Three', 'Remote']);
  });

  it('follows a teammate\'s rename of the tab being renamed while the draft is untouched', () => {
    const { editor, strip } = mount();
    const tab = [...strip().querySelectorAll<HTMLElement>('[data-testid="tabs-strip-tab"]')].find((el) => el.textContent === 'Two')!;
    tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = strip().querySelector<HTMLInputElement>('[data-testid="tabs-strip-rename"]')!;
    update(editor, () => {
      const panel = $getRoot().getChildren().find($isTabsNode)!.getPanels()[1];
      (panel as TabPanelNode).setName('Dos');
    });
    expect(strip().querySelector('[data-testid="tabs-strip-rename"]')).toBe(input);
    expect(input.value).toBe('Dos');
  });

  it('moves the dragged tab, not whichever tab now sits at its old index', async () => {
    const { editor, strip } = mount();
    const data = new Map<string, string>();
    const transfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() { return [...data.keys()]; },
    };
    const tabs = () => [...strip().querySelectorAll<HTMLElement>('[data-testid="tabs-strip-tab"]')];
    const drag = (el: HTMLElement, type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      el.dispatchEvent(event);
    };

    drag(tabs().find((el) => el.textContent === 'Three')!, 'dragstart');
    // A teammate inserts a tab at the front mid-drag.
    update(editor, () => {
      const tabsNode = $getRoot().getChildren().find($isTabsNode)!;
      const added = $addTab(tabsNode, 'Remote');
      tabsNode.getPanels()[0].insertBefore(added);
    });
    drag(tabs().find((el) => el.textContent === 'One')!, 'drop');
    await settle();

    expect(panelNames(editor)).toEqual(['Remote', 'Three', 'One', 'Two']);
  });
});

describe('tab menus', () => {
  const tabButton = (strip: HTMLElement, name: string) =>
    [...strip.querySelectorAll<HTMLElement>('[data-testid="tabs-strip-tab"]')].find((el) => el.textContent === name)!;
  const menuItem = (id: string) => document.querySelector<HTMLElement>(`.tabs-menu [data-tab-action="${id}"]`);

  it('a tab\'s context menu acts on that tab, not the one showing', async () => {
    const { editor, strip } = mount();
    tabButton(strip(), 'Three').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    // The last tab cannot move right.
    expect(menuItem('move-right')).toBeNull();
    menuItem('move-left')!.click();
    await settle();
    expect(panelNames(editor)).toEqual(['One', 'Three', 'Two']);
    expect(document.querySelector('.tabs-menu')).toBeNull();
  });

  it('the block menu adds a tab and deletes the tab showing', async () => {
    const { editor, strip } = mount();
    // The block menu reads the node in a read and runs the item outside it.
    const tabsNode = editor.getEditorState().read(() => $getRoot().getChildren().find($isTabsNode)!);
    const items = draggableBlockMenuRegistry.getMenuItemsForNode(tabsNode);
    const run = (id: string) => items.find((item) => item.id === `tabs:${id}`)!.command(editor, tabsNode);

    run('add');
    await settle();
    expect(panelNames(editor)).toEqual(['One', 'Two', 'Three', 'Tab 4']);

    tabButton(strip(), 'Two').click();
    run('delete');
    await settle();
    expect(panelNames(editor)).toEqual(['One', 'Three', 'Tab 4']);
  });
});
