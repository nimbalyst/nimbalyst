/**
 * The tab actions and the menu that offers them. One list feeds every surface:
 * the strip's options button, a tab's context menu, and the block menu, so a
 * tab can be added, renamed, moved or deleted the same way from each.
 *
 * The strip registers a controller per editor; the block menu, which only
 * knows the editor and the tabs node, reaches the showing tab through it.
 */

import type { LexicalEditor, NodeKey } from 'lexical';
import { computePosition, flip, offset, shift } from '@floating-ui/react';

export type TabActionId = 'add' | 'rename' | 'move-left' | 'move-right' | 'delete';

export interface TabAction {
  id: TabActionId;
  label: string;
  icon: string;
}

/** The actions that apply to the tab at `index` of `count`, in menu order. */
export function tabActionsFor(index: number, count: number): TabAction[] {
  const actions: TabAction[] = [
    { id: 'add', label: 'Add tab', icon: 'add' },
    { id: 'rename', label: 'Rename tab', icon: 'edit' },
  ];
  if (index > 0) actions.push({ id: 'move-left', label: 'Move tab left', icon: 'chevron_left' });
  if (index < count - 1) actions.push({ id: 'move-right', label: 'Move tab right', icon: 'chevron_right' });
  actions.push({ id: 'delete', label: count > 1 ? 'Delete tab' : 'Delete tabs block', icon: 'delete' });
  return actions;
}

export interface TabStripController {
  /** The panel showing in a tabs block, or null if the block is gone. */
  showing(tabsKey: NodeKey): NodeKey | null;
  run(tabsKey: NodeKey, panelKey: NodeKey, action: TabActionId): void;
}

const controllers = new WeakMap<LexicalEditor, TabStripController>();

export function setTabStripController(editor: LexicalEditor, controller: TabStripController): () => void {
  controllers.set(editor, controller);
  return () => {
    if (controllers.get(editor) === controller) controllers.delete(editor);
  };
}

export function getTabStripController(editor: LexicalEditor): TabStripController | undefined {
  return controllers.get(editor);
}

let closeOpenMenu: (() => void) | null = null;

export function closeTabMenu(): void {
  closeOpenMenu?.();
}

/**
 * Opens the menu for one tab at `anchor` (an element, or a point for a
 * context menu). Only one tab menu is open at a time.
 */
export function openTabMenu(
  anchor: Element | { x: number; y: number },
  actions: TabAction[],
  onPick: (action: TabActionId) => void,
): void {
  closeTabMenu();
  const menu = document.createElement('div');
  menu.className = 'tabs-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('data-testid', 'tabs-menu');
  for (const action of actions) {
    if (action.id === 'delete') menu.append(Object.assign(document.createElement('div'), { className: 'tabs-menu-divider' }));
    const item = document.createElement('button');
    item.type = 'button';
    item.className = action.id === 'delete' ? 'tabs-menu-item is-danger' : 'tabs-menu-item';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-tab-action', action.id);
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = action.icon;
    item.append(icon, action.label);
    // mousedown would move the caret out of the panel before the click lands.
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', () => {
      close();
      onPick(action.id);
    });
    menu.append(item);
  }
  document.body.append(menu);

  const reference = anchor instanceof Element
    ? anchor
    : { getBoundingClientRect: () => DOMRect.fromRect({ x: anchor.x, y: anchor.y, width: 0, height: 0 }) };
  void computePosition(reference, menu, {
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  }).then(({ x, y }) => Object.assign(menu.style, { left: `${x}px`, top: `${y}px` }));

  const onPointer = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  function close() {
    menu.remove();
    document.removeEventListener('mousedown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    if (closeOpenMenu === close) closeOpenMenu = null;
  }
  document.addEventListener('mousedown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  closeOpenMenu = close;
}
