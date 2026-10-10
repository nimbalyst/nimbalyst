/**
 * The tabs block: a `TabsNode` container whose children are `TabPanelNode`s,
 * each a shadow root holding ordinary block content. Markdown lives in
 * `TabsTransformer.ts`.
 *
 * Both nodes keep the attribute text of the tags they were read from, so
 * attributes this version does not model come back verbatim, and the panel
 * keeps its `<summary>` HTML as written; only a rename re-encodes it.
 *
 * Which tab is showing is view state, not document state: nothing here
 * records it. The editor-side strip (`tabStrip.ts`) owns it per editor.
 *
 * React- and CSS-free so the collab worker and CLI can load it.
 */

import {
  $applyNodeReplacement,
  $createParagraphNode,
  ElementNode,
  type EditorConfig,
  type ElementDOMSlot,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
  setDOMUnmanaged,
} from 'lexical';

export const TABS_DEFAULT_ATTRS = ' data-tabs';
export const TAB_PANEL_DEFAULT_ATTRS = ' data-tab';

const STRIP_CLASS = 'tabs-strip';
const PANELS_CLASS = 'tabs-panels';

export type SerializedTabsNode = Spread<{ attrs: string }, SerializedElementNode>;
export type SerializedTabPanelNode = Spread<{ attrs: string; summary: string }, SerializedElementNode>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** The text a `<summary>` shows: entities decoded, tags dropped. */
export function summaryToName(summary: string): string {
  return summary
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_match, entity: string) => ENTITIES[entity])
    .trim();
}

export function nameToSummary(name: string): string {
  return name.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class TabsNode extends ElementNode {
  /** Attribute text of the `<div ...>` opener, leading space included. */
  __attrs: string;

  constructor(attrs: string = TABS_DEFAULT_ATTRS, key?: NodeKey) {
    super(key);
    this.__attrs = attrs;
  }

  static getType(): string {
    return 'tabs';
  }

  static clone(node: TabsNode): TabsNode {
    return new TabsNode(node.__attrs, node.__key);
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'tabs-block';
    const strip = document.createElement('div');
    strip.className = STRIP_CLASS;
    strip.contentEditable = 'false';
    strip.setAttribute('role', 'tablist');
    // The strip draws its own children; Lexical's mutation observer would remove them.
    setDOMUnmanaged(strip);
    const panels = document.createElement('div');
    panels.className = PANELS_CLASS;
    dom.append(strip, panels);
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const panels = element.querySelector<HTMLElement>(`:scope > .${PANELS_CLASS}`);
    return panels ? super.getDOMSlot(element).withElement(panels) : super.getDOMSlot(element);
  }

  static importJSON(serializedNode: SerializedTabsNode): TabsNode {
    return $createTabsNode().updateFromJSON(serializedNode);
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedTabsNode>): this {
    const self = super.updateFromJSON(serializedNode).getWritable();
    self.__attrs = serializedNode.attrs ?? TABS_DEFAULT_ATTRS;
    return self;
  }

  exportJSON(): SerializedTabsNode {
    return { ...super.exportJSON(), attrs: this.getAttrs() };
  }

  isShadowRoot(): boolean {
    return false;
  }

  canBeEmpty(): boolean {
    return false;
  }

  getAttrs(): string {
    return this.getLatest().__attrs;
  }

  getPanels(): TabPanelNode[] {
    return this.getChildren().filter($isTabPanelNode);
  }
}

export class TabPanelNode extends ElementNode {
  /** Attribute text of the `<details ...>` opener, leading space included. */
  __attrs: string;
  /** Inner HTML of `<summary>`, as written. */
  __summary: string;

  constructor(summary: string = '', attrs: string = TAB_PANEL_DEFAULT_ATTRS, key?: NodeKey) {
    super(key);
    this.__summary = summary;
    this.__attrs = attrs;
  }

  static getType(): string {
    return 'tab-panel';
  }

  static clone(node: TabPanelNode): TabPanelNode {
    return new TabPanelNode(node.__summary, node.__attrs, node.__key);
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'tabs-panel';
    dom.setAttribute('role', 'tabpanel');
    return dom;
  }

  updateDOM(): boolean {
    return false;
  }

  static importJSON(serializedNode: SerializedTabPanelNode): TabPanelNode {
    return $createTabPanelNode().updateFromJSON(serializedNode);
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedTabPanelNode>): this {
    const self = super.updateFromJSON(serializedNode).getWritable();
    self.__attrs = serializedNode.attrs ?? TAB_PANEL_DEFAULT_ATTRS;
    self.__summary = serializedNode.summary ?? '';
    return self;
  }

  exportJSON(): SerializedTabPanelNode {
    return { ...super.exportJSON(), attrs: this.getAttrs(), summary: this.getSummary() };
  }

  isShadowRoot(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  getAttrs(): string {
    return this.getLatest().__attrs;
  }

  getSummary(): string {
    return this.getLatest().__summary;
  }

  getName(): string {
    return summaryToName(this.getSummary());
  }

  /** Renaming re-encodes the summary; an unchanged name keeps the text as written. */
  setName(name: string): this {
    if (name.trim() === this.getName()) return this;
    const self = this.getWritable();
    self.__summary = nameToSummary(name);
    return self;
  }
}

export function $createTabsNode(attrs: string = TABS_DEFAULT_ATTRS): TabsNode {
  return $applyNodeReplacement(new TabsNode(attrs));
}

export function $createTabPanelNode(summary: string = '', attrs: string = TAB_PANEL_DEFAULT_ATTRS): TabPanelNode {
  return $applyNodeReplacement(new TabPanelNode(summary, attrs));
}

export function $isTabsNode(node: LexicalNode | null | undefined): node is TabsNode {
  return node instanceof TabsNode;
}

export function $isTabPanelNode(node: LexicalNode | null | undefined): node is TabPanelNode {
  return node instanceof TabPanelNode;
}

// ---------------------------------------------------------------------------
// Tab operations. Pure tree edits, so the strip, the slash command and the
// tests share them.

/** A tab name not already used in `tabs`: "Tab 3", "Tab 4", ... */
export function $nextTabName(tabs: TabsNode): string {
  const used = new Set(tabs.getPanels().map((panel) => panel.getName()));
  let index = tabs.getPanels().length + 1;
  while (used.has(`Tab ${index}`)) index += 1;
  return `Tab ${index}`;
}

/** A tabs block with one empty panel per name. */
export function $createTabsWithPanels(names: string[]): TabsNode {
  const tabs = $createTabsNode();
  for (const name of names) {
    tabs.append($createTabPanelNode(nameToSummary(name)).append($createParagraphNode()));
  }
  return tabs;
}

export function $addTab(tabs: TabsNode, name?: string): TabPanelNode {
  const panel = $createTabPanelNode(nameToSummary(name?.trim() || $nextTabName(tabs)));
  panel.append($createParagraphNode());
  tabs.append(panel);
  return panel;
}

/** Moves a panel `delta` places, clamped to the strip. Returns whether it moved. */
export function $moveTab(panel: TabPanelNode, delta: number): boolean {
  const tabs = panel.getParent();
  if (!$isTabsNode(tabs)) return false;
  const panels = tabs.getPanels();
  const from = panels.findIndex((candidate) => candidate.is(panel));
  const to = Math.max(0, Math.min(panels.length - 1, from + delta));
  if (from === -1 || to === from) return false;
  if (to < from) panels[to].insertBefore(panel);
  else panels[to].insertAfter(panel);
  return true;
}

/**
 * Deletes a panel and its content. Deleting the only panel removes the whole
 * block, leaving a paragraph where it was. Returns the panel to show next.
 */
export function $deleteTab(panel: TabPanelNode): TabPanelNode | null {
  const tabs = panel.getParent();
  if (!$isTabsNode(tabs)) return null;
  const panels = tabs.getPanels();
  if (panels.length <= 1) {
    tabs.replace($createParagraphNode());
    return null;
  }
  const index = panels.findIndex((candidate) => candidate.is(panel));
  const next = panels[index + 1] ?? panels[index - 1] ?? null;
  panel.remove();
  return next;
}
