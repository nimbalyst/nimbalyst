/**
 * Integration tests for AI provider list editing capabilities
 *
 * These tests verify that AI providers can correctly handle list editing operations
 * by making the right tool calls with the correct parameters.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ProviderFactory } from '../../server/ProviderFactory';
import type { DocumentContext } from '../../server/types';

describe('AI Provider List Editing Integration', () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const runIntegration = process.env.RUN_OPENAI_INTEGRATION === '1';

  afterEach(() => {
    ProviderFactory.destroyAll();
  });

  it.skipIf(!apiKey || !runIntegration)('should stream correct content when adding to end of list', async () => {
    const testDocument: DocumentContext = {
      filePath: '/test/list.md',
      fileType: 'markdown',
      content: `# Shopping List

- Apples
- Bananas
- Oranges
`,
      cursorPosition: { line: 5, column: 0 }
    };

    // Initialize provider
    const provider = ProviderFactory.createProvider('openai', 'test-list');
    await provider.initialize({
      apiKey: apiKey!,
      model: 'gpt-4-turbo-preview',
      maxTokens: 500
    });

    // Send message asking to add to end of list
    const chunks: any[] = [];
    const stream = provider.sendMessage(
      'Add "Grapes" to the end of the shopping list',
      testDocument
    );

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // Verify the AI called streamContent (it auto-executes and emits stream_edit chunks)
    const editStartChunk = chunks.find(c => c.type === 'stream_edit_start');
    const editContentChunks = chunks.filter(c => c.type === 'stream_edit_content');
    const editEndChunk = chunks.find(c => c.type === 'stream_edit_end');

    expect(editStartChunk).toBeDefined();
    expect(editContentChunks.length).toBeGreaterThan(0);
    expect(editEndChunk).toBeDefined();

    // Verify the AI generated the correct content
    const allContent = editContentChunks.map(c => c.content).join('');
    console.log('✅ AI streamed content:', allContent);
    expect(allContent).toContain('Grapes');
    expect(allContent).toMatch(/^-\s+Grapes/); // Should be a list item

    console.log('✅ Test passed: AI correctly used streamContent to add list item');
  }, 30000);

});
