/**
 * Integration tests for OpenAI Provider
 * Tests actual tool usage and file editing capabilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderFactory } from '../../server/ProviderFactory';
import type { DocumentContext } from '../../server/types';

describe('OpenAI Provider - Tool Usage', () => {
  const apiKey = process.env.OPENAI_API_KEY;
  const runOpenAiIntegration = process.env.RUN_OPENAI_INTEGRATION === '1';
  
  afterEach(() => {
    ProviderFactory.destroyAll();
  });

  it.skipIf(!apiKey || !runOpenAiIntegration)('should use applyDiff tool to edit document', async () => {
    // The document we're going to edit
    const testDocument: DocumentContext = {
      filePath: '/test/document.md',
      fileType: 'markdown',
      content: '# Hello World\n\nThis is a test document.\n\nIt has multiple lines.',
      cursorPosition: { line: 1, column: 0 }
    };

    // Initialize provider
    const provider = ProviderFactory.createProvider('openai', 'test-edit');
    await provider.initialize({
      apiKey: apiKey!,
      model: 'gpt-4o-mini',
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

  it.skipIf(!apiKey || !runOpenAiIntegration)('should test GPT-5 response time', async () => {
    const testDocument: DocumentContext = {
      filePath: '/test/document.md',
      fileType: 'markdown',
      content: 'Test',
      cursorPosition: { line: 1, column: 0 }
    };

    const provider = ProviderFactory.createProvider('openai', 'test-gpt5');
    
    console.log('\n=== TESTING GPT-5 TIMING ===');
    const initStart = Date.now();
    await provider.initialize({
      apiKey: apiKey!,
      model: 'gpt-5',
      maxTokens: 10
    });
    console.log(`Initialization took: ${Date.now() - initStart}ms`);

    provider.registerToolHandler({
      applyDiff: async (args: any) => ({ success: true })
    });

    const messageStart = Date.now();
    console.log('Sending message to GPT-5...');
    
    const stream = provider.sendMessage('Hi', testDocument);
    
    let firstChunkTime: number | undefined;
    let chunkCount = 0;
    
    for await (const chunk of stream) {
      chunkCount++;
      if (!firstChunkTime) {
        firstChunkTime = Date.now() - messageStart;
        console.log(`FIRST CHUNK received after: ${firstChunkTime}ms`);
      }
      console.log(`Chunk ${chunkCount}:`, chunk.type);
    }
    
    const totalTime = Date.now() - messageStart;
    console.log(`\nTOTAL TIME: ${totalTime}ms`);
    console.log(`Chunks received: ${chunkCount}`);
    
    expect(totalTime).toBeLessThan(5000); // Should be way faster than 15-30 seconds
  }, 40000);

  it.skipIf(!apiKey || !runOpenAiIntegration)('should use streamContent tool to insert content', async () => {
    // Document where we'll insert content
    const testDocument: DocumentContext = {
      filePath: '/test/document.md',
      fileType: 'markdown',
      content: '# Shopping List\n\nHere are the items:\n\n',
      cursorPosition: { line: 4, column: 0 } // Position after the empty line
    };

    // Initialize provider
    const provider = ProviderFactory.createProvider('openai', 'test-stream');
    await provider.initialize({
      apiKey: apiKey!,
      model: 'gpt-4o-mini',
      maxTokens: 500
    });

    // Track what was streamed
    const streamedContent: string[] = [];
    let streamStarted = false;
    let streamEnded = false;
    let streamConfig: any = null;
    
    // Register tool handler (streamContent might use real-time streaming)
    provider.registerToolHandler({
      streamContent: async (args: any) => {
        console.log('📝 streamContent handler called with:', JSON.stringify(args, null, 2));
        streamedContent.push(args.content);
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

      if (chunk.type === 'tool_call' && chunk.toolCall) {
        console.log(`🔧 Tool called: ${chunk.toolCall.name}`);
      }
    }
    
    // OpenAI might use either streaming or tool calls
    const hasStreamEdit = streamStarted && streamEnded;
    const hasToolCall = chunks.some(c => c.type === 'tool_call' && c.toolCall?.name === 'streamContent');
    
    // Should use one approach or the other
    expect(hasStreamEdit || hasToolCall).toBe(true);
    
    if (hasStreamEdit) {
      console.log('✅ Used streaming approach');
      // Verify stream config
      expect(streamConfig).toBeDefined();
      expect(streamConfig.position).toBeDefined();
    } else if (hasToolCall) {
      console.log('✅ Used tool call approach');
    }
    
    // Verify the content includes the fruits
    const allStreamedText = streamedContent.join('');
    if (allStreamedText) {
      expect(allStreamedText.toLowerCase()).toContain('apple');
      expect(allStreamedText.toLowerCase()).toContain('banana');
      expect(allStreamedText.toLowerCase()).toContain('orange');
      console.log('Total streamed content:', allStreamedText);
    }
    
    console.log('✅ Content verification passed!');
  }, 10000); // 10 second timeout for API call
});
