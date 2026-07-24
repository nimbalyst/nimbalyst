/**
 * Integration tests for Claude SDK Provider
 * Tests actual tool usage and file editing capabilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderFactory } from '../../server/ProviderFactory';
import type { DocumentContext } from '../../server/types';

describe('Claude SDK Provider - Tool Usage', () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const runProviderTests = process.env.RUN_AI_PROVIDER_TESTS === 'true';
  const model = process.env.ANTHROPIC_TEST_MODEL || 'claude-sonnet-4-6';

  afterEach(() => {
    ProviderFactory.destroyAll();
  });

  it.skipIf(!apiKey || !runProviderTests)('should use applyDiff tool to edit document', async () => {
    // The document we're going to edit
    const testDocument: DocumentContext = {
      filePath: '/test/document.md',
      fileType: 'markdown',
      content: '# Hello World\n\nThis is a test document.\n\nIt has multiple lines.',
      cursorPosition: { line: 1, column: 0 }
    };

    // Initialize provider
    const provider = ProviderFactory.createProvider('claude', 'test-edit');
    await provider.initialize({
      apiKey: apiKey!,
      model,
      maxTokens: 500
    });

    // Track what edits were requested
    const editsReceived: any[] = [];

    // Register tool handler that captures the edit requests
    provider.registerToolHandler({
      applyDiff: async (args: any) => {
        console.log('📝 applyDiff called with:', JSON.stringify(args, null, 2));
        editsReceived.push(args);
        return { success: true, message: 'Edit applied' };
      }
    });

    // Send a message asking to make a specific edit
    const chunks: any[] = [];
    const stream = provider.sendMessage(
      'Change "Hello World" to "Hello Universe" in the document',
      testDocument
    );

    // Collect all chunks
    for await (const chunk of stream) {
      chunks.push(chunk);
      if (chunk.type === 'tool_call' && chunk.toolCall) {
        console.log(`🔧 Tool called: ${chunk.toolCall.name}`);
      }
    }

    // Verify the tool was called
    const toolCallChunks = chunks.filter(c => c.type === 'tool_call');
    expect(toolCallChunks.length).toBeGreaterThan(0);
    expect(toolCallChunks[0].toolCall?.name).toBe('applyDiff');

    // Verify we received edit instructions
    expect(editsReceived.length).toBeGreaterThan(0);

    // Check the edit contains the expected changes
    const edit = editsReceived[0];
    expect(edit.replacements).toBeDefined();
    expect(Array.isArray(edit.replacements)).toBe(true);
    expect(edit.replacements.length).toBeGreaterThan(0);

    // The edit should change "Hello World" to "Hello Universe"
    const replacement = edit.replacements[0];
    expect(replacement.oldText).toContain('Hello World');
    expect(replacement.newText).toContain('Hello Universe');

    console.log('✅ Edit verification passed!');
  }, 10000); // 10 second timeout for API call

  it.skipIf(!apiKey || !runProviderTests)('should use streamContent tool to insert content', async () => {
    // Document where we'll insert content
    const testDocument: DocumentContext = {
      filePath: '/test/document.md',
      fileType: 'markdown',
      content: '# Shopping List\n\nHere are the items:\n\n',
      cursorPosition: { line: 4, column: 0 } // Position after the empty line
    };

    // Initialize provider
    const provider = ProviderFactory.createProvider('claude', 'test-stream');
    await provider.initialize({
      apiKey: apiKey!,
      model,
      maxTokens: 500
    });

    // Track what was streamed
    const streamedContent: string[] = [];
    let streamStarted = false;
    let streamEnded = false;
    let streamConfig: any = null;

    // Register tool handler (streamContent uses real-time streaming, not this handler)
    provider.registerToolHandler({
      streamContent: async (args: any) => {
        console.log('📝 streamContent handler called (unexpected)');
        return { success: true };
      }
    });

    // Send a message asking to add items to the list
    const chunks: any[] = [];
    const stream = provider.sendMessage(
      'Add three fruits to my shopping list: Apple, Banana, and Orange. Use bullet points.',
      testDocument
    );

    // Collect all chunks and track streaming events
    for await (const chunk of stream) {
      chunks.push(chunk);

      if (chunk.type === 'stream_edit_start') {
        streamStarted = true;
        streamConfig = chunk.config;
        console.log('🚀 Stream started with config:', chunk.config);
      }

      if (chunk.type === 'stream_edit_content' && chunk.content !== undefined) {
        streamedContent.push(chunk.content);
        console.log('📝 Streaming content:', chunk.content);
      }

      if (chunk.type === 'stream_edit_end') {
        streamEnded = true;
        console.log('✅ Stream ended');
      }
    }

    // Verify streaming happened
    expect(streamStarted).toBe(true);
    expect(streamEnded).toBe(true);

    // Check we got stream_edit chunks
    const streamEditChunks = chunks.filter(c =>
      c.type === 'stream_edit_start' ||
      c.type === 'stream_edit_content' ||
      c.type === 'stream_edit_end'
    );
    expect(streamEditChunks.length).toBeGreaterThan(0);

    // Verify the content includes the fruits
    const allStreamedText = streamedContent.join('');
    expect(allStreamedText.toLowerCase()).toContain('apple');
    expect(allStreamedText.toLowerCase()).toContain('banana');
    expect(allStreamedText.toLowerCase()).toContain('orange');

    // Verify stream config
    expect(streamConfig).toBeDefined();
    expect(streamConfig.position).toBeDefined();
    console.log('Stream position was:', streamConfig.position);

    console.log('✅ Streaming verification passed!');
    console.log('Total streamed content:', allStreamedText);
  }, 10000); // 10 second timeout for API call
});
