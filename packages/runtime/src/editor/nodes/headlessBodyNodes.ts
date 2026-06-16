/**
 * Node set for the headless (main-process) Lexical editor that seeds tracker
 * body Y.Docs from markdown (see `MainBodyDocService` /
 * `HeadlessLexicalYDoc`).
 *
 * Why this exists separately from `EditorNodes`:
 *   `EditorNodes` deliberately OMITS every node that a renderer editor
 *   extension registers (list, link, auto-link, horizontal rule, image, ...).
 *   In the renderer those nodes arrive through the composed extension graph
 *   (`buildNimbalystRootExtension`). The headless seeder can't build that graph
 *   — it would pull DOM-only extension code into the main process — so it took
 *   only `EditorNodes`. The result: any body whose markdown produced a node
 *   outside that minimal set (e.g. a GitHub issue with a bullet list) threw
 *   "Node list is not registered" inside `$convertFromEnhancedMarkdownString`,
 *   which aborts the whole conversion, so the body Y.Doc was never seeded and
 *   the collaborative editor mounted empty.
 *
 * This list adds the node CLASSES that the core + built-in markdown
 * transformers (`getEditorTransformers()`) can emit. The classes are already
 * imported into the main process today via `registerBuiltinExtensions`, so
 * importing them here is main-safe — only their `decorate()` (which we never
 * call headlessly) touches React/DOM. Nodes with no markdown syntax (kanban,
 * collapsible, layout) are intentionally excluded: markdown can't produce them.
 *
 * Kept in sync by `headlessBodyNodes.test.ts`, which converts representative
 * markdown and asserts no "not registered" error escapes.
 */

import type { Klass, LexicalNode } from 'lexical';
import { ListNode, ListItemNode } from '@lexical/list';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { HorizontalRuleNode } from '@lexical/extension';

import EditorNodes from './EditorNodes';
import { ImageNode } from '../plugins/ImagesPlugin';
import { PageBreakNode } from '../plugins/PageBreakPlugin';
import { MermaidNode } from '../plugins/MermaidPlugin';
import { EmbeddedFileNode } from '../plugins/EmbedPlugin/EmbeddedFileNode';

const HeadlessBodyNodes: Array<Klass<LexicalNode>> = [
  ...EditorNodes,
  ListNode,
  ListItemNode,
  LinkNode,
  AutoLinkNode,
  HorizontalRuleNode,
  PageBreakNode,
  ImageNode,
  MermaidNode,
  EmbeddedFileNode,
];

export default HeadlessBodyNodes;
export { HeadlessBodyNodes };
