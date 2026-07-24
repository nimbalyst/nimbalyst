import {describe, expect, it} from 'vitest';
import {$getRoot, type LexicalEditor, type NodeKey} from 'lexical';

import {MarkdownStreamProcessor} from '../MarkdownStreamProcessor';
import {$convertFromEnhancedMarkdownString} from '../EnhancedMarkdownImport';
import {$convertToEnhancedMarkdownString} from '../EnhancedMarkdownExport';
import {
  createTestEditor,
  MARKDOWN_TEST_TRANSFORMERS,
} from '../../plugins/DiffPlugin/__tests__/utils/testConfig';

function exportMarkdown(editor: LexicalEditor): string {
  let out = '';
  editor.update(
    () => {
      out = $convertToEnhancedMarkdownString(MARKDOWN_TEST_TRANSFORMERS, {
        includeFrontmatter: false,
        shouldPreserveNewLines: true,
      });
    },
    {discrete: true},
  );
  return out;
}

function importMarkdown(editor: LexicalEditor, markdown: string): void {
  editor.update(
    () => {
      $convertFromEnhancedMarkdownString(markdown, MARKDOWN_TEST_TRANSFORMERS);
    },
    {discrete: true},
  );
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

describe('MarkdownStreamProcessor', () => {
  it('matches a one-shot import when the body is streamed in small chunks', async () => {
    const header = '# Doc Title';
    const body = [
      '',
      '## Section one',
      '',
      'A paragraph with **bold** and *italic*.',
      '',
      '- bullet one',
      '- bullet two',
      '',
      '## Section two',
      '',
      'Another paragraph.',
      '',
    ].join('\n');

    // Streaming editor: seed with header, anchor an 'after' processor to it,
    // then push the body through in 5-character windows the way AI tokens arrive.
    const streamedEditor = createTestEditor();
    importMarkdown(streamedEditor, header);

    let headingKey: NodeKey | null = null;
    streamedEditor.read(() => {
      const first = $getRoot().getFirstChild();
      headingKey = first?.getKey() ?? null;
    });
    expect(headingKey).not.toBeNull();

    const processor = new MarkdownStreamProcessor(
      streamedEditor,
      MARKDOWN_TEST_TRANSFORMERS,
      headingKey!,
      'after',
    );

    for (const chunk of chunkText(body, 5)) {
      await processor.insertWithUpdate(chunk);
    }

    const streamedExport = exportMarkdown(streamedEditor);

    // One-shot editor: import the same header + body in a single pass.
    const oneShotEditor = createTestEditor();
    importMarkdown(oneShotEditor, header + '\n' + body);
    const oneShotExport = exportMarkdown(oneShotEditor);

    expect(streamedExport).toBe(oneShotExport);
  });
});
