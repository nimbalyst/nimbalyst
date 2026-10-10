/**
 * The tab strip drawn above each tabs block, and which panel is showing.
 *
 * The strip is plain DOM inside the node's non-editable header (element nodes
 * cannot decorate), redrawn from the editor state whenever a tabs block or a
 * panel changes. The selected tab is view state for this editor only: it lives
 * in a map keyed by the tabs node, and a teammate's editor keeps its own.
 */

import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import { $findMatchingParent, mergeRegister } from '@lexical/utils';

import {
  $addTab,
  $deleteTab,
  $isTabPanelNode,
  $isTabsNode,
  $moveTab,
  TabPanelNode,
  TabsNode,
} from './TabsNodes';
import { closeTabMenu, openTabMenu, setTabStripController, tabActionsFor, type TabActionId } from './tabMenu';

interface TabView {
  key: NodeKey;
  name: string;
}

function icon(name: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'material-symbols-outlined';
  span.textContent = name;
  return span;
}

function iconButton(name: string, label: string, testId: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tabs-strip-action';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('data-testid', testId);
  button.append(icon(name));
  // mousedown would move the caret out of the panel before the click lands.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

const TAB_DRAG_TYPE = 'application/x-nimbalyst-tab';

export function registerTabStrips(editor: LexicalEditor): () => void {
  /** Selected panel per tabs block. View state only; never written to the node. */
  const selected = new Map<NodeKey, NodeKey>();
  /**
   * The rename in progress, per tabs block. The input lives here, not in the
   * strip, so a redraw for a teammate's edit keeps the same element, its
   * draft and its focus. `baseline` is the name the draft started from.
   */
  const renaming = new Map<NodeKey, { panelKey: NodeKey; input: HTMLInputElement; baseline: string }>();
  /** Set while the strip's children are being rearranged, when a moved input may blur. */
  let reconciling = false;

  const select = (tabsKey: NodeKey, panelKey: NodeKey) => {
    selected.set(tabsKey, panelKey);
    render(tabsKey);
  };

  const mutate = (fn: () => void) => editor.update(fn);

  function readTabs(tabsKey: NodeKey): TabView[] | null {
    return editor.getEditorState().read(() => {
      const tabs = $getNodeByKey(tabsKey);
      if (!$isTabsNode(tabs)) return null;
      return tabs.getPanels().map((panel) => ({
        key: panel.getKey(),
        name: panel.getName() || 'Untitled',
      }));
    });
  }

  function startRename(tabsKey: NodeKey, tab: TabView): void {
    const input = document.createElement('input');
    input.className = 'tabs-strip-rename';
    input.value = tab.name;
    input.setAttribute('data-testid', 'tabs-strip-rename');
    const entry = { panelKey: tab.key, input, baseline: tab.name };
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      renaming.delete(tabsKey);
      const name = input.value.trim();
      if (commit && name) {
        mutate(() => {
          const panel = $getNodeByKey(entry.panelKey);
          if ($isTabPanelNode(panel)) panel.setName(name);
        });
      }
      render(tabsKey);
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => {
      if (!reconciling) finish(true);
    });
    renaming.set(tabsKey, entry);
    render(tabsKey);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  }

  /**
   * Makes `strip` hold `children` in order, moving as little as possible: the
   * rename input stays put unless its tab moved, and gets its focus and
   * selection back if moving it lost them.
   */
  function reconcile(strip: HTMLElement, children: Node[]): void {
    const keep = new Set(children);
    const focused = document.activeElement instanceof HTMLInputElement && strip.contains(document.activeElement)
      ? { input: document.activeElement, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
      : null;
    reconciling = true;
    try {
      for (const child of [...strip.childNodes]) if (!keep.has(child)) child.remove();
      children.forEach((child, index) => {
        if (strip.childNodes[index] !== child) strip.insertBefore(child, strip.childNodes[index] ?? null);
      });
    } finally {
      reconciling = false;
    }
    if (focused && document.activeElement !== focused.input && strip.contains(focused.input)) {
      focused.input.focus();
      focused.input.setSelectionRange(focused.start, focused.end);
    }
  }

  function render(tabsKey: NodeKey): void {
    const dom = editor.getElementByKey(tabsKey);
    const strip = dom?.querySelector<HTMLElement>(':scope > .tabs-strip');
    const tabs = readTabs(tabsKey);
    if (!dom || !strip || !tabs) return;

    const active = tabs.find((tab) => tab.key === selected.get(tabsKey)) ?? tabs[0];
    if (active) selected.set(tabsKey, active.key);
    const editable = editor.isEditable();

    for (const tab of tabs) {
      editor.getElementByKey(tab.key)?.classList.toggle('is-active', tab.key === active?.key);
    }

    const rename = renaming.get(tabsKey);
    if (rename && (!editable || !tabs.some((tab) => tab.key === rename.panelKey))) renaming.delete(tabsKey);

    const children: Node[] = [];
    for (const tab of tabs) {
      const entry = renaming.get(tabsKey);
      if (entry?.panelKey === tab.key) {
        // An untouched draft follows a teammate's rename; an edited one is kept.
        if (entry.input.value === entry.baseline && tab.name !== entry.baseline) entry.input.value = tab.name;
        entry.baseline = tab.name;
        children.push(entry.input);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = tab.key === active?.key ? 'tabs-strip-tab is-active' : 'tabs-strip-tab';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab.key === active?.key));
      button.setAttribute('data-testid', 'tabs-strip-tab');
      button.textContent = tab.name;
      button.title = editable ? 'Double-click to rename, drag to reorder, right-click for options' : tab.name;
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => select(tabsKey, tab.key));
      if (editable) {
        button.addEventListener('dblclick', () => startRename(tabsKey, tab));
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          const index = tabs.indexOf(tab);
          openTabMenu({ x: event.clientX, y: event.clientY }, tabActionsFor(index, tabs.length), (action) => run(tabsKey, tab.key, action));
        });
        button.draggable = true;
        // Keys, not positions: a teammate's insert mid-drag must not change which tab moves.
        button.addEventListener('dragstart', (event) => {
          event.dataTransfer?.setData(TAB_DRAG_TYPE, `${tabsKey}:${tab.key}`);
        });
        button.addEventListener('dragover', (event) => {
          if (event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) event.preventDefault();
        });
        button.addEventListener('drop', (event) => {
          const [fromTabs, movingKey] = (event.dataTransfer?.getData(TAB_DRAG_TYPE) ?? '').split(':');
          if (fromTabs !== tabsKey || !movingKey) return;
          event.preventDefault();
          mutate(() => {
            const moving = $getNodeByKey(movingKey);
            const target = $getNodeByKey(tab.key);
            const parent = $isTabPanelNode(moving) ? moving.getParent() : null;
            if (!$isTabPanelNode(moving) || !$isTabPanelNode(target) || !$isTabsNode(parent) || !target.getParent()?.is(parent)) return;
            const panels = parent.getPanels();
            $moveTab(moving, panels.findIndex((panel) => panel.is(target)) - panels.findIndex((panel) => panel.is(moving)));
          });
        });
      }
      children.push(button);
    }

    if (!editable || !active) {
      reconcile(strip, children);
      return;
    }
    // Add sits with the tabs; everything else is in the menu, as on a tab's context menu.
    children.push(iconButton('add', 'Add tab', 'tabs-strip-add', () => run(tabsKey, active.key, 'add')));
    const actions = document.createElement('span');
    actions.className = 'tabs-strip-actions';
    const more = iconButton('more_horiz', 'Tab options', 'tabs-strip-options', () => {
      const index = tabs.indexOf(active);
      openTabMenu(more, tabActionsFor(index, tabs.length), (action) => run(tabsKey, active.key, action));
    });
    actions.append(more);
    children.push(actions);
    reconcile(strip, children);
  }

  /** One tab action, from the strip, a tab's context menu or the block menu. */
  function run(tabsKey: NodeKey, panelKey: NodeKey, action: TabActionId): void {
    if (!editor.isEditable()) return;
    const tab = readTabs(tabsKey)?.find((candidate) => candidate.key === panelKey);
    if (!tab) return;
    switch (action) {
      case 'add':
        mutate(() => {
          const tabsNode = $getNodeByKey(tabsKey);
          if (!$isTabsNode(tabsNode)) return;
          const panel = $addTab(tabsNode);
          selected.set(tabsKey, panel.getKey());
          panel.selectStart();
        });
        return;
      case 'rename':
        selected.set(tabsKey, panelKey);
        startRename(tabsKey, tab);
        return;
      case 'move-left':
      case 'move-right':
        mutate(() => {
          const panel = $getNodeByKey(panelKey);
          if ($isTabPanelNode(panel)) $moveTab(panel, action === 'move-left' ? -1 : 1);
        });
        return;
      case 'delete': {
        // No confirmation: native dialogs are banned in runtime source, and the
        // deletion is an ordinary editor update that undo restores.
        mutate(() => {
          const panel = $getNodeByKey(panelKey);
          if (!$isTabPanelNode(panel)) return;
          const next = $deleteTab(panel);
          if (next && selected.get(tabsKey) === panelKey) selected.set(tabsKey, next.getKey());
        });
      }
    }
  }

  const live = new Set<NodeKey>();
  const renderAll = () => live.forEach(render);

  return mergeRegister(
    setTabStripController(editor, {
      showing: (tabsKey) => {
        const tabs = readTabs(tabsKey);
        return tabs?.find((tab) => tab.key === selected.get(tabsKey))?.key ?? tabs?.[0]?.key ?? null;
      },
      run,
    }),
    closeTabMenu,
    editor.registerMutationListener(TabsNode, (mutations) => {
      for (const [key, mutation] of mutations) {
        if (mutation === 'destroyed') {
          live.delete(key);
          selected.delete(key);
          renaming.delete(key);
        } else {
          live.add(key);
        }
      }
      renderAll();
    }, { skipInitialization: false }),
    editor.registerMutationListener(TabPanelNode, () => renderAll(), { skipInitialization: true }),
    editor.registerEditableListener(() => renderAll()),
    // A caret that lands in a hidden panel (arrow keys, search, undo) shows that panel.
    editor.registerUpdateListener(({ editorState }) => {
      const target = editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return null;
        const panel = $findMatchingParent(selection.anchor.getNode(), $isTabPanelNode);
        const tabs = panel?.getParent();
        return panel && $isTabsNode(tabs) ? { tabsKey: tabs.getKey(), panelKey: panel.getKey() } : null;
      });
      if (target && selected.get(target.tabsKey) !== target.panelKey) select(target.tabsKey, target.panelKey);
    }),
  );
}
