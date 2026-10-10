import type { MultilineElementTransformer } from '@lexical/markdown';
import { createPlacedViewUrl, parsePlacedViewUrl } from '../../../core/placedViewUrl';
import { $createEmbeddedFileNode, $isEmbeddedFileNode, EmbeddedFileNode } from './EmbeddedFileNodeCore';

export const NAMED_PAGE_VIEW_ID = 'namedPageView';
export interface NamedPageView { id: string; name: string; type: string; attrs: Record<string, string> }

export function parseNamedPageView(source: string): NamedPageView {
  const value = JSON.parse(source) as NamedPageView;
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.type !== 'string' || !value.type || !value.attrs || typeof value.attrs !== 'object' || Array.isArray(value.attrs)
    || Object.values(value.attrs).some(value => typeof value !== 'string') || NAMED_PAGE_VIEW_ID in value.attrs) throw new Error('Invalid named view.');
  return { id: value.id, name: value.name, type: value.type, attrs: value.attrs };
}

export function namedPageViewFromNode(node: EmbeddedFileNode): NamedPageView | null {
  const { [NAMED_PAGE_VIEW_ID]: id, ...attrs } = node.getAttrs();
  if (!id) return null;
  const target = parsePlacedViewUrl(node.getSrc());
  if (target?.kind !== 'type') throw new Error('This named view has no type.');
  return { id, name: node.getLabel(), type: target.typeId, attrs };
}

/** One fence per view; existing embedded nodes keep names and individual settings independently mergeable. */
export const NAMED_PAGE_VIEW_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [EmbeddedFileNode],
  type: 'multiline-element',
  regExpStart: /^[ \t]*```page-view[ \t]*$/,
  regExpEnd: /^[ \t]*```[ \t]*$/,
  replace: (root, _children, _start, _end, lines) => {
    let view: NamedPageView;
    try { view = parseNamedPageView((lines ?? []).join('\n')); } catch { return false; }
    root.append($createEmbeddedFileNode({ src: createPlacedViewUrl({ kind: 'type', typeId: view.type, scope: 'local' }), label: view.name, attrs: { ...view.attrs, [NAMED_PAGE_VIEW_ID]: view.id } }));
    return true;
  },
  export: node => {
    if (!$isEmbeddedFileNode(node)) return null;
    const view = namedPageViewFromNode(node);
    return view ? '```page-view\n' + JSON.stringify(view) + '\n```' : null;
  },
};
