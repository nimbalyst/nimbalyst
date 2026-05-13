/**
 * Collapsible plugin module: imports the stylesheet and re-exports the
 * nodes, transformer, command identity, and the `$createStyledCollapsible`
 * helper. The runtime registrations live in
 * `editor/extensions/builtin/CollapsibleExtension.ts`.
 */

import './Collapsible.css';

import {
  $createParagraphNode,
} from 'lexical';

import {
  $createCollapsibleContainerNode,
  CollapsibleContainerNode,
} from './CollapsibleContainerNode';
import {
  $createCollapsibleContentNode,
  CollapsibleContentNode,
} from './CollapsibleContentNode';
import {
  $createCollapsibleTitleNode,
  CollapsibleTitleNode,
} from './CollapsibleTitleNode';

export { INSERT_COLLAPSIBLE_COMMAND } from './CollapsibleCommands';
export { COLLAPSIBLE_TRANSFORMER } from './CollapsibleTransformer';
export {
  CollapsibleContainerNode,
  $createCollapsibleContainerNode,
  $isCollapsibleContainerNode,
} from './CollapsibleContainerNode';
export {
  CollapsibleContentNode,
  $createCollapsibleContentNode,
  $isCollapsibleContentNode,
} from './CollapsibleContentNode';
export {
  CollapsibleTitleNode,
  $createCollapsibleTitleNode,
  $isCollapsibleTitleNode,
} from './CollapsibleTitleNode';

/**
 * Helper that mirrors the original plugin's exported factory: builds a
 * full collapsible block (container + title + content) with empty
 * paragraphs in each slot. Used by tracker scaffolding and tests.
 */
export function $createStyledCollapsible(options: {
  classification?: string;
  isOpen?: boolean;
  readOnly?: boolean;
}) {
  const { classification, isOpen = true, readOnly = false } = options;
  const container = $createCollapsibleContainerNode(isOpen, classification, readOnly);
  const title = $createCollapsibleTitleNode();
  const content = $createCollapsibleContentNode();
  const titleParagraph = $createParagraphNode();
  const contentParagraph = $createParagraphNode();
  title.append(titleParagraph);
  content.append(contentParagraph);
  container.append(title, content);
  return { container, title, content, titleParagraph, contentParagraph };
}
