/**
 * Markdown import/export for the code excerpt block. Unlike the shared fence
 * helper, the fence length varies: the snapshot is someone's code and may
 * itself hold a ``` line (a markdown file, a doc comment), so export picks a
 * fence longer than any backtick run in the body, and import closes only on a
 * fence at least as long as the opener. The body is kept exactly as written,
 * blank edge lines included, since they are part of the quoted range.
 */

import type { MultilineElementTransformer } from '@lexical/markdown';

import { $createCodeExcerptNode, $isCodeExcerptNode, CodeExcerptNode } from './CodeExcerptNodeCore';
import { CODE_EXCERPT_FENCE_LANGUAGE } from './excerptFence';

export function excerptFence(source: string): string {
  const longest = Math.max(2, ...Array.from(source.matchAll(/`{3,}/g), (match) => match[0].length));
  return '`'.repeat(longest + 1);
}

export const CODE_EXCERPT_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [CodeExcerptNode],
  type: 'multiline-element',
  export: (node) => {
    if (!$isCodeExcerptNode(node)) return null;
    const source = node.getSource();
    const fence = excerptFence(source);
    return `${fence}${CODE_EXCERPT_FENCE_LANGUAGE}\n${source}\n${fence}`;
  },
  regExpStart: new RegExp(`^[ \\t]*(\`{3,})${CODE_EXCERPT_FENCE_LANGUAGE}[ \\t]*$`),
  regExpEnd: { optional: true, regExp: /^[ \t]*`{3,}[ \t]*$/ },
  handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex, startMatch }) => {
    const close = new RegExp(`^[ \\t]*\`{${startMatch[1].length},}[ \\t]*$`);
    let end = startLineIndex + 1;
    while (end < lines.length && !close.test(lines[end])) end += 1;
    // An unterminated fence still becomes the block, like the other fences.
    rootNode.append($createCodeExcerptNode({ source: lines.slice(startLineIndex + 1, end).join('\n') }));
    return [true, Math.min(end, lines.length - 1)];
  },
  replace: () => false,
};
