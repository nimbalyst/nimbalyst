# sendMessage() Refactoring Analysis

## Overview

The `sendMessage()` method in ClaudeCodeProvider is ~1,700 lines and handles the entire agent interaction loop. This document proposes how to refactor it into smaller, testable helper methods without changing the architecture.

**Current:** Single 1,700-line generator method
**Proposed:** Structured method with 10-15 focused helper methods
**Goal:** Maintainability and readability, not line count reduction

---

## Current Structure Analysis

### Logical Phases in sendMessage()

```
1. Setup & Initialization (lines 502-513)
   - Capture hidden mode flag
   - Set current mode
   - Initialize constants

2. Attachment Processing (lines 517-611)
   - Process images → base64 content blocks
   - Process PDFs → document content blocks
   - Process text files → inline or write to /tmp
   - Image compression

3. Abort & Context Setup (lines 614-651)
   - Abort existing requests
   - Create abort controller
   - Create tool hooks service
   - Clear edited files tracker

4. Document Context & System Prompt (lines 653-729)
   - Build user message additions
   - Add large attachment references
   - Load environment variables
   - Build system prompt

5. Prompt Additions Emission (lines 735-757)
   - Emit for UI display
   - Build attachment summaries

6. SDK Options Configuration (lines 762-917)
   - Determine settings sources
   - Configure SDK options
   - Load extension plugins
   - Add additional directories
   - Apply tool restrictions
   - Set environment variables
   - Enable task tools
   - Preserve team context

7. Session Management (lines 934-983)
   - Setup executable options
   - Handle session resumption
   - Handle branching/forking

8. SDK Query Execution (lines 985-1089)
   - Log input message
   - Build prompt (streaming or simple)
   - Call SDK query()
   - Get iterator

9. Stream Processing Loop (lines 1100-2100+)
   - Process chunks (text, tool_use, tool_result, result, compact_boundary)
   - Handle teammate messages
   - Log to database
   - Track usage
   - Emit events
   - Create file snapshots

10. Completion & Cleanup (lines 2100-2236)
    - Final usage tracking
    - Session data updates
    - Error handling
```

---

## Proposed Refactoring Structure

### High-Level Structure

```typescript
async *sendMessage(
  message: string,
  documentContext?: DocumentContext,
  sessionId?: string,
  messages?: Message[],
  workspacePath?: string,
  attachments?: any[]
): AsyncIterableIterator<StreamChunk> {
  // 1. Setup
  const context = this.initializeSendMessageContext(documentContext, workspacePath);

  // 2. Process attachments
  const attachmentData = await this.processAttachments(attachments);

  // 3. Build prompt components
  const promptComponents = await this.buildPromptComponents(
    message,
    documentContext,
    attachmentData,
    sessionId
  );

  // 4. Configure SDK
  const sdkOptions = await this.buildSDKOptions(
    context,
    promptComponents.systemPrompt,
    sessionId
  );

  // 5. Execute query
  const queryIterator = await this.executeSDKQuery(
    promptComponents,
    attachmentData,
    sdkOptions,
    sessionId
  );

  // 6. Process stream
  yield* this.processSDKStream(
    queryIterator,
    context,
    sessionId,
    workspacePath
  );

  // 7. Finalize
  await this.finalizeSendMessage(context, sessionId);
}
```

---

## Detailed Helper Methods

### 1. Context Initialization

```typescript
/**
 * Initialize the context for a sendMessage() call
 * Captures hidden mode flag, sets current mode, creates abort controller
 */
private initializeSendMessageContext(
  documentContext?: DocumentContext,
  workspacePath?: string
): SendMessageContext {
  // Capture hidden mode flag and reset
  const hideMessages = this.markMessagesAsHidden;
  this.markMessagesAsHidden = false;

  // Track session mode
  this.currentMode = (documentContext as any)?.mode || 'agent';

  // Abort existing request
  if (this.abortController) {
    this.abortController.abort();
  }

  // Create new abort controller
  const abortController = new AbortController();
  this.abortController = abortController;

  // Get permissions path (worktree or workspace)
  const permissionsPath = documentContext?.permissionsPath || workspacePath;

  return {
    hideMessages,
    mode: this.currentMode,
    abortController,
    permissionsPath,
    startTime: Date.now(),
  };
}

interface SendMessageContext {
  hideMessages: boolean;
  mode: 'planning' | 'agent';
  abortController: AbortController;
  permissionsPath?: string;
  startTime: number;
}
```

---

### 2. Attachment Processing

```typescript
/**
 * Process all attachments and prepare content blocks
 * Handles images, PDFs, and text files
 */
private async processAttachments(attachments?: any[]): Promise<AttachmentData> {
  const imageContentBlocks: ImageBlockParam[] = [];
  const documentContentBlocks: DocumentBlockParam[] = [];
  const largeAttachmentFilePaths: { filename: string; filepath: string }[] = [];

  if (!attachments || attachments.length === 0) {
    return { imageContentBlocks, documentContentBlocks, largeAttachmentFilePaths };
  }

  for (const attachment of attachments) {
    if (attachment.type === 'image') {
      const imageBlock = await this.processImageAttachment(attachment);
      if (imageBlock) imageContentBlocks.push(imageBlock);
    } else if (attachment.type === 'pdf') {
      const docBlock = await this.processPDFAttachment(attachment);
      if (docBlock) documentContentBlocks.push(docBlock);
    } else if (attachment.type === 'text' || attachment.type === 'document') {
      const result = await this.processTextAttachment(attachment);
      if (result.contentBlock) {
        documentContentBlocks.push(result.contentBlock);
      }
      if (result.largeFilePath) {
        largeAttachmentFilePaths.push(result.largeFilePath);
      }
    }
  }

  return { imageContentBlocks, documentContentBlocks, largeAttachmentFilePaths };
}

interface AttachmentData {
  imageContentBlocks: ImageBlockParam[];
  documentContentBlocks: DocumentBlockParam[];
  largeAttachmentFilePaths: { filename: string; filepath: string }[];
}

/**
 * Process a single image attachment
 * Compresses if needed and converts to base64 content block
 */
private async processImageAttachment(
  attachment: any
): Promise<ImageBlockParam | null> {
  if (!attachment.filepath) return null;

  try {
    // Read image file
    let imageData = await fs.promises.readFile(attachment.filepath);
    let mimeType = attachment.mimeType || 'image/png';

    // Compress if needed
    if (ClaudeCodeProvider.imageCompressor) {
      const compressed = await ClaudeCodeProvider.imageCompressor(imageData, mimeType);
      imageData = Buffer.from(compressed.buffer);
      mimeType = compressed.mimeType;
    }

    const base64Data = imageData.toString('base64');
    const mediaType = this.normalizeImageMediaType(mimeType);

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64Data
      }
    };
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to read image attachment:', error);
    return null;
  }
}

/**
 * Normalize image MIME type to API-supported media type
 */
private normalizeImageMediaType(
  mimeType: string
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/gif') return 'image/gif';
  if (normalized === 'image/webp') return 'image/webp';
  return 'image/png';
}

/**
 * Process a single PDF attachment
 * Converts to base64 document content block
 */
private async processPDFAttachment(
  attachment: any
): Promise<DocumentBlockParam | null> {
  if (!attachment.filepath) return null;

  try {
    const pdfData = await fs.promises.readFile(attachment.filepath);
    const base64Data = pdfData.toString('base64');
    const filename = attachment.filename || path.basename(attachment.filepath);

    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64Data
      },
      title: filename
    };
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to read PDF attachment:', error);
    return null;
  }
}

/**
 * Process a single text/document attachment
 * Small files sent inline, large files written to /tmp
 */
private async processTextAttachment(attachment: any): Promise<{
  contentBlock?: DocumentBlockParam;
  largeFilePath?: { filename: string; filepath: string };
}> {
  const LARGE_ATTACHMENT_CHAR_THRESHOLD = 10000;

  if (!attachment.filepath) return {};

  try {
    const content = await fs.promises.readFile(attachment.filepath, 'utf-8');
    const filename = attachment.filename || path.basename(attachment.filepath);

    if (content.length > LARGE_ATTACHMENT_CHAR_THRESHOLD) {
      // Large file - write to /tmp
      const tmpPath = path.join(os.tmpdir(), `attachment-${Date.now()}-${filename}`);
      await fs.promises.writeFile(tmpPath, content, 'utf-8');
      return { largeFilePath: { filename, filepath: tmpPath } };
    } else {
      // Small file - send inline
      return {
        contentBlock: {
          type: 'document',
          source: {
            type: 'text',
            text: content
          },
          title: filename
        }
      };
    }
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to read text attachment:', error);
    return {};
  }
}
```

---

### 3. Prompt Building

```typescript
/**
 * Build all prompt components (user message, system prompt)
 * Handles document context, attachments, environment variables
 */
private async buildPromptComponents(
  message: string,
  documentContext: DocumentContext | undefined,
  attachmentData: AttachmentData,
  sessionId?: string
): Promise<PromptComponents> {
  // Build user message with document context
  let userMessage = message;
  let systemPrompt = '';

  if (documentContext?.editorContext || documentContext?.transitionContext) {
    const isSlashCommand = message.trim().startsWith('/');

    if (!isSlashCommand) {
      // Add document context prompt
      const contextAddition = this.buildDocumentContextAddition(documentContext);
      userMessage = contextAddition + userMessage;

      // Add one-time editing instructions
      if (this.shouldIncludeEditingInstructions(sessionId)) {
        systemPrompt = this.buildEditingInstructionsPrompt();
      }
    }
  }

  // Add large attachment references to system prompt
  if (attachmentData.largeAttachmentFilePaths.length > 0) {
    systemPrompt = this.addLargeAttachmentReferences(
      systemPrompt,
      attachmentData.largeAttachmentFilePaths
    );
  }

  // Load environment variables
  const settingsEnv = await this.loadSettingsEnvironment();
  const shellEnv = this.loadShellEnvironment();

  // Build final system prompt
  const finalSystemPrompt = this.buildSystemPrompt(
    documentContext,
    settingsEnv?.agentTeamsEnabled || false
  );

  // Merge system prompts
  const combinedSystemPrompt = [systemPrompt, finalSystemPrompt]
    .filter(Boolean)
    .join('\n\n');

  return {
    userMessage,
    systemPrompt: combinedSystemPrompt,
    settingsEnv,
    shellEnv,
  };
}

interface PromptComponents {
  userMessage: string;
  systemPrompt: string;
  settingsEnv: Record<string, string> | null;
  shellEnv: Record<string, string> | null;
}

/**
 * Build document context addition to user message
 */
private buildDocumentContextAddition(documentContext: DocumentContext): string {
  // Implementation extracted from current inline logic
  // Uses DocumentContextService pre-built prompts
  return ''; // Placeholder
}

/**
 * Check if editing instructions should be included
 */
private shouldIncludeEditingInstructions(sessionId?: string): boolean {
  // Check if this is the first message with a document open
  return false; // Placeholder
}

/**
 * Build editing instructions prompt
 */
private buildEditingInstructionsPrompt(): string {
  return ''; // Placeholder
}

/**
 * Add large attachment file references to system prompt
 */
private addLargeAttachmentReferences(
  systemPrompt: string,
  largeAttachmentFilePaths: { filename: string; filepath: string }[]
): string {
  const references = largeAttachmentFilePaths
    .map(f => `- ${f.filename}: ${f.filepath}`)
    .join('\n');

  const attachmentSection = `\n\nLarge attachments (use Read tool to access):\n${references}`;

  if (systemPrompt.includes('</worktree>')) {
    return systemPrompt.replace('</worktree>', `${attachmentSection}\n</worktree>`);
  } else {
    return systemPrompt + attachmentSection;
  }
}

/**
 * Load settings environment variables
 */
private async loadSettingsEnvironment(): Promise<Record<string, string> | null> {
  if (!ClaudeCodeProvider.claudeSettingsEnvLoader) return null;

  try {
    return await ClaudeCodeProvider.claudeSettingsEnvLoader();
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to load settings env:', error);
    return null;
  }
}

/**
 * Load shell environment variables
 */
private loadShellEnvironment(): Record<string, string> | null {
  if (!ClaudeCodeProvider.shellEnvironmentLoader) return null;

  try {
    return ClaudeCodeProvider.shellEnvironmentLoader();
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to load shell env:', error);
    return null;
  }
}
```

---

### 4. SDK Configuration

```typescript
/**
 * Build SDK options for query execution
 * Handles settings sources, tool restrictions, environment, plugins
 */
private async buildSDKOptions(
  context: SendMessageContext,
  systemPrompt: string,
  sessionId?: string,
  workspacePath?: string,
  promptComponents?: PromptComponents
): Promise<any> {
  const options: any = {
    cwd: workspacePath,
    systemPrompt,
    model: this.resolveModelVariant(),
  };

  // Determine settings sources
  options.settingsSources = await this.determineSettingsSources();

  // Enable 1M context if needed
  if (this.is1MModel()) {
    options.beta = ['1m'];
  }

  // Set permission mode
  options.permissionMode = 'default';

  // Set tool handlers
  options.canUseTool = this.createCanUseToolHandler(sessionId, workspacePath, context.permissionsPath);
  options.preToolUse = this.toolHooksService?.createPreToolUseHook();
  options.postToolUse = this.toolHooksService?.createPostToolUseHook();

  // Load MCP servers
  options.mcpServers = await this.mcpConfigService?.getMcpServersConfig({
    sessionId,
    workspacePath
  });

  // Load extension plugins
  const extensionPlugins = await this.loadExtensionPlugins(workspacePath);
  if (extensionPlugins) {
    options.extensionPlugins = extensionPlugins;
  }

  // Add additional directories
  const additionalDirs = await this.loadAdditionalDirectories(workspacePath);
  if (additionalDirs) {
    options.additionalDirectories = additionalDirs;
  }

  // Apply tool restrictions for planning mode
  if (context.mode === 'planning') {
    const { allowedTools, disallowedTools } = this.getPlanningModeToolRestrictions();
    options.allowedTools = allowedTools;
    options.disallowedTools = disallowedTools;
  }

  // Set environment variables
  options.env = this.buildSDKEnvironment(promptComponents);

  // Enable task tools
  options.taskToolsEnabled = true;

  // Preserve team context
  if (sessionId) {
    const teamContext = this.teammateManager.getTeamContextForSession(sessionId);
    if (teamContext) {
      options.teamContext = teamContext;
    }
  }

  // Set executable options (production only)
  if (app.isPackaged) {
    options.pathToClaudeCodeExecutable = await this.findCliPath();
    options.executable = getClaudeCodeExecutableOptions(
      ClaudeCodeProvider.useStandaloneBinary
    );
    options.spawn = getClaudeCodeSpawnFunction();
  }

  // Set abort controller
  options.abortController = context.abortController;

  return options;
}

/**
 * Determine which settings sources to enable
 */
private async determineSettingsSources(): Promise<string[]> {
  if (!ClaudeCodeProvider.claudeCodeSettingsLoader) {
    return ['local', 'user', 'project'];
  }

  try {
    const settings = await ClaudeCodeProvider.claudeCodeSettingsLoader();
    const sources = ['local'];
    if (settings.userCommandsEnabled) sources.push('user');
    if (settings.projectCommandsEnabled) sources.push('project');
    return sources;
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to load settings:', error);
    return ['local', 'user', 'project'];
  }
}

/**
 * Get tool restrictions for planning mode
 */
private getPlanningModeToolRestrictions(): {
  allowedTools: string[];
  disallowedTools: string[];
} {
  const allowedTools = [
    'Read', 'Glob', 'Grep', 'LS',
    'Write', 'Edit', 'MultiEdit', // For markdown files only
    'WebFetch', 'WebSearch',
    'ExitPlanMode',
  ];

  const disallowedTools = [
    'Bash', 'Task', 'TaskOutput', 'TaskStop',
    'TeamCreate', 'TeamDelete', 'SendMessage',
  ];

  return { allowedTools, disallowedTools };
}

/**
 * Build environment variables for SDK
 */
private buildSDKEnvironment(promptComponents?: PromptComponents): Record<string, string> {
  const env: Record<string, string> = {};

  // Add shell env
  if (promptComponents?.shellEnv) {
    Object.assign(env, promptComponents.shellEnv);
  }

  // Add settings env (overrides shell)
  if (promptComponents?.settingsEnv) {
    Object.assign(env, promptComponents.settingsEnv);
  }

  // Enable MCP tool search
  env.ANTHROPIC_MCP_TOOL_SEARCH = 'auto';

  // Set effort level if not high
  const effortLevel = this.config.effortLevel || DEFAULT_EFFORT_LEVEL;
  if (effortLevel !== 'high') {
    env.ANTHROPIC_EFFORT_LEVEL = effortLevel;
  }

  return env;
}

/**
 * Load extension plugins
 */
private async loadExtensionPlugins(
  workspacePath?: string
): Promise<Array<{ type: 'local'; path: string }> | null> {
  if (!ClaudeCodeProvider.extensionPluginsLoader) return null;

  try {
    return await ClaudeCodeProvider.extensionPluginsLoader(workspacePath);
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to load extension plugins:', error);
    return null;
  }
}

/**
 * Load additional directories
 */
private async loadAdditionalDirectories(
  workspacePath?: string
): Promise<string[] | null> {
  if (!ClaudeCodeProvider.additionalDirectoriesLoader || !workspacePath) return null;

  try {
    return ClaudeCodeProvider.additionalDirectoriesLoader(workspacePath);
  } catch (error) {
    console.error('[CLAUDE-CODE] Failed to load additional directories:', error);
    return null;
  }
}
```

---

### 5. Query Execution

```typescript
/**
 * Execute SDK query and return iterator
 * Handles session resumption, branching, and prompt building
 */
private async executeSDKQuery(
  promptComponents: PromptComponents,
  attachmentData: AttachmentData,
  options: any,
  sessionId?: string
): Promise<AsyncIterableIterator<any>> {
  // Handle session resumption/branching
  if (sessionId) {
    const existingSessionId = this.sessions.getSessionId(sessionId);

    if (existingSessionId) {
      options.resume = existingSessionId;
    } else {
      // Check for branched session
      const branchedFrom = this.sessions.getBranchedFromSession(sessionId);
      if (branchedFrom) {
        const sourceProviderSessionId = this.sessions.getSessionId(branchedFrom);
        if (sourceProviderSessionId) {
          options.fork = sourceProviderSessionId;
        }
      }
    }
  }

  // Build prompt (streaming or simple)
  const prompt = this.buildSDKPrompt(
    promptComponents.userMessage,
    attachmentData
  );

  // Execute query
  const leadConfig = {
    workspacePath: options.cwd,
    sessionId: sessionId || undefined,
    model: options.model,
  };

  this.teammateManager.setLeadConfig(leadConfig);

  return query(prompt, options);
}

/**
 * Build SDK prompt with attachments
 * Uses streaming input mode if attachments present
 */
private buildSDKPrompt(
  userMessage: string,
  attachmentData: AttachmentData
): string | AsyncIterableIterator<MessageParam> {
  const hasAttachments =
    attachmentData.imageContentBlocks.length > 0 ||
    attachmentData.documentContentBlocks.length > 0;

  if (hasAttachments) {
    // Streaming input mode with content blocks
    const contentBlocks: ContentBlockParam[] = [
      ...attachmentData.imageContentBlocks,
      ...attachmentData.documentContentBlocks,
      { type: 'text', text: userMessage },
    ];

    return this.createStreamingInput(contentBlocks);
  } else {
    // Simple string prompt
    return userMessage;
  }
}

/**
 * Create streaming input generator for attachments
 */
private async *createStreamingInput(
  contentBlocks: ContentBlockParam[]
): AsyncIterableIterator<MessageParam> {
  yield {
    role: 'user',
    content: contentBlocks,
  };
}
```

---

### 6. Stream Processing

```typescript
/**
 * Process SDK stream chunks
 * Handles text, tool_use, tool_result, result, compact_boundary chunks
 */
private async *processSDKStream(
  queryIterator: AsyncIterableIterator<any>,
  context: SendMessageContext,
  sessionId?: string,
  workspacePath?: string
): AsyncIterableIterator<StreamChunk> {
  const state = this.initializeStreamState();

  try {
    for await (const chunk of queryIterator) {
      // Check for teammate interrupts
      if (this.hasTeammateInterrupt && this.teammateManager.hasPendingTeammateMessages()) {
        const teammateMessage = this.teammateManager.drainNextTeammateMessage();
        if (teammateMessage) {
          yield* this.processTeammateMessage(teammateMessage, sessionId);
        }
        this.hasTeammateInterrupt = false;
      }

      // Process chunk by type
      if (chunk.type === 'text') {
        yield* this.processTextChunk(chunk, state, sessionId, context.hideMessages);
      } else if (chunk.type === 'tool_use') {
        yield* this.processToolUseChunk(chunk, state, sessionId);
      } else if (chunk.type === 'tool_result') {
        yield* this.processToolResultChunk(chunk, state, sessionId, workspacePath);
      } else if (chunk.type === 'result') {
        yield* this.processResultChunk(chunk, state, sessionId);
      } else if (chunk.type === 'compact_boundary') {
        yield* this.processCompactBoundaryChunk(chunk, sessionId);
      }
    }
  } finally {
    // Finalize stream
    yield* this.finalizeStream(state, sessionId);
  }
}

/**
 * Initialize stream processing state
 */
private initializeStreamState(): StreamState {
  return {
    fullText: '',
    toolCalls: new Map(),
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    perModelUsage: [],
    hasDisplayableContent: false,
    providerSessionId: null,
  };
}

interface StreamState {
  fullText: string;
  toolCalls: Map<string, any>;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  perModelUsage: any[];
  hasDisplayableContent: boolean;
  providerSessionId: string | null;
}

/**
 * Process a text chunk
 */
private async *processTextChunk(
  chunk: any,
  state: StreamState,
  sessionId?: string,
  hideMessages?: boolean
): AsyncIterableIterator<StreamChunk> {
  state.fullText += chunk.text;
  state.hasDisplayableContent = true;

  yield {
    type: 'text',
    text: chunk.text,
    hidden: hideMessages,
  };
}

/**
 * Process a tool_use chunk
 */
private async *processToolUseChunk(
  chunk: any,
  state: StreamState,
  sessionId?: string
): AsyncIterableIterator<StreamChunk> {
  // Log tool use to database
  await this.logToolUse(chunk, sessionId);

  // Track tool call
  state.toolCalls.set(chunk.toolUseId, chunk);

  // Yield to UI
  yield {
    type: 'tool_call',
    toolCall: {
      id: chunk.toolUseId,
      name: chunk.toolName,
      arguments: chunk.toolInput,
    },
  };
}

/**
 * Process a tool_result chunk
 */
private async *processToolResultChunk(
  chunk: any,
  state: StreamState,
  sessionId?: string,
  workspacePath?: string
): AsyncIterableIterator<StreamChunk> {
  // Log tool result to database
  await this.logToolResult(chunk, sessionId);

  // Handle teammate-specific tool results
  if (this.shouldProcessTeammateToolResult(chunk)) {
    this.processTeammateToolResult(
      sessionId,
      chunk.toolName,
      chunk.toolInput,
      chunk.result,
      chunk.isError
    );
  }

  // Update tool call with result
  const toolCall = state.toolCalls.get(chunk.toolUseId);
  if (toolCall) {
    toolCall.result = chunk.result;
  }

  // Yield to UI
  yield {
    type: 'tool_result',
    toolResult: {
      id: chunk.toolUseId,
      name: chunk.toolName,
      result: chunk.result,
    },
  };
}

/**
 * Process a result chunk (final completion)
 */
private async *processResultChunk(
  chunk: any,
  state: StreamState,
  sessionId?: string
): AsyncIterableIterator<StreamChunk> {
  // Capture provider session ID
  state.providerSessionId = chunk.providerSessionId;

  // Update session mapping
  if (sessionId && chunk.providerSessionId) {
    this.sessions.setSessionId(sessionId, chunk.providerSessionId);
  }

  // Track usage
  if (chunk.usage) {
    state.usage = chunk.usage;
  }

  if (chunk.perModelUsage) {
    state.perModelUsage = chunk.perModelUsage;
  }

  // Log assistant response
  if (state.fullText) {
    await this.logAgentMessage(sessionId, 'output', state.fullText);
  }

  // Emit usage
  yield {
    type: 'usage',
    usage: state.usage,
  };
}

/**
 * Process a compact_boundary chunk (turn complete)
 */
private async *processCompactBoundaryChunk(
  chunk: any,
  sessionId?: string
): AsyncIterableIterator<StreamChunk> {
  // Create file snapshots for edited files
  if (this.toolHooksService) {
    await this.toolHooksService.createTurnEndSnapshots(sessionId);
  }

  yield {
    type: 'turn_complete',
  };
}

/**
 * Finalize stream processing
 */
private async *finalizeStream(
  state: StreamState,
  sessionId?: string
): AsyncIterableIterator<StreamChunk> {
  // Emit final completion
  yield {
    type: 'complete',
    usage: state.usage,
  };
}

// Helper methods for logging
private async logToolUse(chunk: any, sessionId?: string): Promise<void> {
  // Implementation
}

private async logToolResult(chunk: any, sessionId?: string): Promise<void> {
  // Implementation
}

private shouldProcessTeammateToolResult(chunk: any): boolean {
  return chunk.toolName === 'Task' || chunk.toolName === 'SendMessage';
}
```

---

## Benefits of Refactoring

### Readability
- Each helper method has a single, clear purpose
- ~100-150 lines per method vs 1,700 lines in one method
- Easier to understand control flow

### Testability
- Individual helper methods can be unit tested
- Mock attachments, document context, SDK responses
- Test error handling in isolation

### Maintainability
- Changes to attachment processing don't affect stream processing
- Can optimize individual phases without touching others
- Clear boundaries for debugging

### Reusability
- Helper methods could be reused by CodexProvider
- `processAttachments()` could be shared utility
- Stream processing patterns could be abstracted

---

## Implementation Strategy

### Phase 1: Extract Setup & Config (Week 1)
1. Extract `initializeSendMessageContext()`
2. Extract `buildPromptComponents()`
3. Extract `buildSDKOptions()`
4. Test that sendMessage still works

### Phase 2: Extract Attachment Processing (Week 2)
1. Extract `processAttachments()`
2. Extract `processImageAttachment()`
3. Extract `processPDFAttachment()`
4. Extract `processTextAttachment()`
5. Test attachment handling

### Phase 3: Extract Stream Processing (Week 3)
1. Extract `processSDKStream()`
2. Extract `processTextChunk()`
3. Extract `processToolUseChunk()`
4. Extract `processToolResultChunk()`
5. Extract `processResultChunk()`
6. Test stream processing

### Phase 4: Integration & Testing (Week 4)
1. Update all existing tests
2. Add tests for new helper methods
3. Verify no regressions
4. Update documentation

---

## Success Criteria

- [ ] sendMessage() reduced to ~200 lines (main flow)
- [ ] 10-15 focused helper methods extracted
- [ ] All existing tests still pass
- [ ] New unit tests for helper methods
- [ ] No change to external behavior
- [ ] Code is more readable and maintainable
- [ ] Helper methods are well-documented

---

## Risks & Mitigations

**Risk:** Breaking generator pattern
**Mitigation:** Use `yield*` for delegating to sub-generators

**Risk:** Performance regression
**Mitigation:** No additional async overhead, just code organization

**Risk:** Test maintenance burden
**Mitigation:** Focus on testing new helper methods, not re-testing entire flow

**Risk:** Incomplete extraction leaving orphaned code
**Mitigation:** Extract in phases, verify after each phase

---

## Comparison: Before vs After

### Before (Current)
```typescript
async *sendMessage(...): AsyncIterableIterator<StreamChunk> {
  // 1,700 lines of everything mixed together
  // - Setup
  // - Attachment processing
  // - Prompt building
  // - SDK configuration
  // - Stream processing
  // - Error handling
  // - Cleanup
}
```

### After (Proposed)
```typescript
async *sendMessage(...): AsyncIterableIterator<StreamChunk> {
  // ~200 lines of high-level flow
  const context = this.initializeSendMessageContext(...);
  const attachmentData = await this.processAttachments(...);
  const promptComponents = await this.buildPromptComponents(...);
  const sdkOptions = await this.buildSDKOptions(...);
  const queryIterator = await this.executeSDKQuery(...);
  yield* this.processSDKStream(...);
  await this.finalizeSendMessage(...);
}

// Plus 10-15 focused helper methods (100-150 lines each)
```

---

## Conclusion

Refactoring `sendMessage()` into helper methods will significantly improve maintainability without changing behavior. The method will remain the same size overall, but will be structured as a clear flow with well-defined helper methods instead of a monolithic 1,700-line function.

**Target State:**
- sendMessage(): ~200 lines (main flow)
- 10-15 helper methods: ~1,500 lines (focused logic)
- Total: ~1,700 lines (same as current, but organized)

**Key Principle:** Structure over size reduction
