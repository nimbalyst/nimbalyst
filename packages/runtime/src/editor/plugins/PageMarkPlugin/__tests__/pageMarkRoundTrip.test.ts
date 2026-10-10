// @vitest-environment node
/**
 * A marked sentence holding a link, emphasis and a citation must come back out
 * of the editor byte for byte, through the renderer's transformer set and the
 * headless one (collab worker, CLI, main-process body seeding).
 */
import { describe, expect, it } from 'vitest';
import { createHeadlessEditor } from '@lexical/headless';
import { $getRoot, $isElementNode, type LexicalNode } from 'lexical';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import '../../../extensions/registerBuiltinExtensions';
import { getEditorTransformers } from '../../../markdown';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';
import { registerReferenceNodeContributions } from '../../../../plugins/referenceNodeContributions';
import { createHumanCitation, formatCitationMarkdown } from '../../../../core/citationSyntax';

const CITATION = formatCitationMarkdown(createHumanCitation({
  sessionId: 'sess-1',
  inputKind: 'answer',
  key: 'toolu_01',
  by: 'Greg Hinkle',
  email: 'greg@example.com',
  at: '2026-09-30',
  quote: 'Say "no" to [our] own engine.\nReally.',
}));

const MARKDOWN = [
  '# Flags',
  '',
  `- [Storage in [Cloudflare Flagship](https://flagship.dev) is **ours** to keep.${CITATION}]{decided by="Greg Hinkle" email=greg@example.com on=2026-09-30 over="our own engine"}`,
  '- [Flagship pricing and latency.]{open by="Spike 6"}',
  '',
  `Plain sentence with a source [TanStack docs](https://tanstack.com/table "cite") and a plain [link](https://example.com) and ${CITATION} after.`,
].join('\n');

function roundTrip(transformers: ReturnType<typeof getEditorTransformers>): { markdown: string; types: string[]; errors: Error[] } {
  const errors: Error[] = [];
  const editor = createHeadlessEditor({
    namespace: 'page-mark-round-trip',
    nodes: [...HeadlessBodyNodes],
    onError: (error: Error) => errors.push(error),
  });
  editor.update(() => {
    $convertFromEnhancedMarkdownString(MARKDOWN, transformers, undefined, true, false);
  }, { discrete: true });
  const types: string[] = [];
  const markdown = editor.getEditorState().read(() => {
    const visit = (node: LexicalNode, depth: number) => {
      types.push(`${'  '.repeat(depth)}${node.getType()}`);
      if ($isElementNode(node)) node.getChildren().forEach((child) => visit(child, depth + 1));
    };
    visit($getRoot(), 0);
    return $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false });
  });
  return { markdown, types, errors };
}

describe('page marks and citations round-trip', () => {
  it('through the editor transformers', () => {
    registerReferenceNodeContributions();
    const { markdown, types, errors } = roundTrip(getEditorTransformers());
    expect(errors).toEqual([]);
    expect(markdown).toBe(MARKDOWN);
    // The mark wraps the link, the bold run and the citation as children.
    const tree = types.join('\n');
    expect(tree).toMatch(/page-mark\n\s+text\n\s+link\n\s+text\n\s+text\n\s+text\n\s+text\n\s+citation/);
    expect(types.filter((t) => t.trim() === 'citation')).toHaveLength(3);
  });

  it('through the headless transformers', () => {
    const { markdown, types, errors } = roundTrip(getHeadlessBodyTransformers());
    expect(errors).toEqual([]);
    expect(markdown).toBe(MARKDOWN);
    expect(types.filter((t) => t.trim() === 'page-mark')).toHaveLength(2);
  });
});
