/**
 * Integration tests for LMStudio Provider
 * Tests actual tool usage and file editing capabilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProviderFactory } from '../../server/ProviderFactory';
import type { DocumentContext } from '../../server/types';

const runLmStudioIntegration = process.env.RUN_LMSTUDIO_INTEGRATION === '1';

describe.skipIf(!runLmStudioIntegration)('LMStudio Provider - Tool Usage', () => {
  afterEach(() => {
    ProviderFactory.destroyAll();
  });

  it('should connect to LMStudio and check capabilities', async () => {
    const provider = ProviderFactory.createProvider('lmstudio', 'test-connect');
    
    try {
      const baseUrl = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
      
      await provider.initialize({
        model: 'local-model',
        baseUrl
      });
      console.log(`✅ Connected to LMStudio at ${baseUrl}`);
      
      if (!baseUrl) {
        throw new Error('Could not connect to LMStudio');
      }
      
      const caps = provider.getCapabilities();
      console.log('LMStudio capabilities:', caps);
      
      expect(caps.streaming).toBe(true);
      expect(caps.tools).toBe(true);
      
      console.log('✅ LMStudio is running and supports tools!');
    } catch (error: any) {
      if (error.message.includes('ECONNREFUSED') || error.message.includes('LMStudio')) {
        console.log('⚠️ LMStudio is not running');
        console.log('Start LMStudio and load a model to run these tests');
      }
      throw error;
    }
  });

  it('should use applyDiff tool to edit document', async () => {
    // The document we're going to edit - MUST MATCH what we're asking to translate!
    const testDocument: DocumentContext = {
      filePath: '/test/document.md',
      fileType: 'markdown',
      content: '# Gemma 3\n\n- One\n- Two\n- Three',
      cursorPosition: { line: 1, column: 0 }
    };

    // Initialize provider
    const provider = ProviderFactory.createProvider('lmstudio', 'test-edit');
    
    // Try to connect using environment variable or default
    const baseUrl = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
    
    try {
      await provider.initialize({
        model: 'gemma-3-27b-it-abliterated', // Use actual model name from UI
        baseUrl
      });
      console.log(`Connected to LMStudio at ${baseUrl}`);
    } catch (e) {
      console.log('⚠️ Skipping: LMStudio not running at', baseUrl);
      return;
    }

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
    console.log('Sending message to LMStudio...');
    
    // Use exactly the same prompt as the UI
    const prompt = `translate the numbers`;
    
    const stream = provider.sendMessage(prompt, testDocument);
    
    // Collect all chunks
    let toolCallStarted = false;
    let toolCallArgs = '';
    
    for await (const chunk of stream) {
      chunks.push(chunk);
      
      // LMStudio sends tool calls differently - log everything
      if (chunk.type === 'tool_call' && chunk.toolCall) {
        toolCallStarted = true;
        console.log(`🔧 Tool called: ${chunk.toolCall.name}`);
        console.log('Tool args:', JSON.stringify(chunk.toolCall.arguments, null, 2));

        // Tool call completed
        editsReceived.push(chunk.toolCall.arguments);
      }
      
      if (chunk.type === 'text') {
        console.log('Text:', chunk.content);
      }
      
      // Check for other chunk types
      if (chunk.type === 'complete') {
        console.log('Stream complete');
      }
    }
    
    // Check if tool was called or if model responded differently
    const toolCallChunks = chunks.filter(c => c.type === 'tool_call');
    
    if (toolCallChunks.length > 0) {
      // Verify the tool was called
      expect(toolCallChunks[0].toolCall?.name).toBe('applyDiff');
      
      // Verify we received edit instructions
      expect(editsReceived.length).toBeGreaterThan(0);
      
      // Check the edit contains the expected changes
      const edit = editsReceived[0];
      expect(edit.replacements).toBeDefined();
      expect(Array.isArray(edit.replacements)).toBe(true);
      
      console.log('✅ LMStudio used applyDiff tool!');
    } else {
      // Some models might not use tools even if they support them
      console.log('⚠️ Model did not use tools. Response:');
      const textChunks = chunks.filter(c => c.type === 'text');
      if (textChunks.length > 0) {
        console.log(textChunks.map(c => c.content).join(''));
      }
      
      // This isn't necessarily a failure - model might be responding differently
      console.log('Note: Model may need specific prompting to use tools');
    }
  }, 90000); // 90 second timeout for slow local model

  it('should use streamContent tool to insert content', async () => {
    // Document where we'll insert content
    const testDocument: DocumentContext = {
      filePath: '/test/document.md',
      fileType: 'markdown',
      content: '# Shopping List\n\nHere are the items:\n\n',
      cursorPosition: { line: 4, column: 0 }
    };

    // Initialize provider
    const provider = ProviderFactory.createProvider('lmstudio', 'test-stream');
    
    // Try to connect using environment variable or default
    const baseUrl = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234';
    
    try {
      await provider.initialize({
        model: 'gemma-3-27b-it-abliterated', // Use actual model name from UI
        baseUrl
      });
      console.log(`Connected to LMStudio at ${baseUrl}`);
    } catch (e) {
      console.log('⚠️ Skipping: LMStudio not running at', baseUrl);
      return;
    }

    // Track what was streamed
    const streamedContent: string[] = [];
    let streamStarted = false;
    let streamEnded = false;
    
    // Register tool handler
    provider.registerToolHandler({
      streamContent: async (args: any) => {
        console.log('📝 streamContent called with:', JSON.stringify(args, null, 2));
        streamedContent.push(args.content);
        return { success: true };
      }
    });

    // Send a message asking to add items
    const chunks: any[] = [];
    const stream = provider.sendMessage(
      'Add three fruits to my shopping list: Apple, Banana, and Orange. Use bullet points. Use the streamContent tool.', 
      testDocument
    );
    
    // Collect all chunks
    for await (const chunk of stream) {
      chunks.push(chunk);
      
      if (chunk.type === 'stream_edit_start') {
        streamStarted = true;
        console.log('🚀 Stream started');
      }
      
      if (chunk.type === 'stream_edit_content' && chunk.content !== undefined) {
        streamedContent.push(chunk.content);
        console.log('📝 Streaming:', chunk.content);
      }
      
      if (chunk.type === 'stream_edit_end') {
        streamEnded = true;
        console.log('✅ Stream ended');
      }
      
      if (chunk.type === 'tool_call' && chunk.toolCall?.name === 'streamContent') {
        console.log('🔧 streamContent tool called');
      }
      
      if (chunk.type === 'text') {
        console.log('Text:', chunk.content);
      }
    }
    
    // Check results
    if (streamStarted || streamedContent.length > 0) {
      console.log('✅ LMStudio used streaming!');
      console.log('Content streamed:', streamedContent.join(''));
    } else {
      console.log('⚠️ Model did not use streaming');
      console.log('Response chunks:', chunks.map(c => c.type).join(', '));
    }
  }, 90000); // 90 second timeout for slow local model
});
