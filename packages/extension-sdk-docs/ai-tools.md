# Adding AI Tools to Extensions

AI tools let Claude interact with your extension programmatically. When you add tools, Claude can read data, make changes, and help users work with your custom file types.

## Why Add AI Tools?

Without tools, Claude can only:
- Read the raw file content
- Suggest edits to the raw content

With tools, Claude can:
- Query structured data ("What columns are in this spreadsheet?")
- Make targeted changes ("Add a row with these values")
- Perform complex operations ("Sort by the date column")
- Understand your data model ("What entities are defined?")

## Tool Definition Structure

Tools are defined in your extension's entry point:

```typescript
// src/index.ts
import type { ExtensionAITool } from '@nimbalyst/extension-sdk';

export const aiTools: ExtensionAITool[] = [
  {
    name: 'my_tool_name',
    description: 'What this tool does - Claude reads this to decide when to use it',
    inputSchema: {
      type: 'object',
      properties: {
        param1: {
          type: 'string',
          description: 'Description of param1',
        },
        param2: {
          type: 'number',
          description: 'Description of param2',
        },
      },
      required: ['param1'],
    },
    handler: async (args, context) => {
      // Implement tool logic
      return { result: 'success' };
    },
  },
];
```

## Registering Tools in the Manifest

Add tools to your `manifest.json`:

```json
{
  "permissions": {
    "ai": true
  },
  "contributions": {
    "aiTools": [
      "myext.get_data",
      "myext.update_data"
    ]
  }
}
```

## Tool Handler Context

The handler receives a context object with useful information:

```typescript
interface AIToolContext {
  // Path to the current workspace (if any)
  workspacePath?: string;

  // Path to the active file (if any)
  activeFilePath?: string;

  // Access host services such as filesystem, UI, and AI helpers
  extensionContext: ExtensionContext;
}
```

## Example: Spreadsheet Tools

Here's a complete example for a CSV/spreadsheet editor:

```typescript
import type {
  AIToolContext,
  ExtensionAITool,
  ExtensionToolResult,
} from '@nimbalyst/extension-sdk';

async function loadActiveFile(context: AIToolContext): Promise<{
  filePath: string;
  content: string;
} | ExtensionToolResult> {
  if (!context.activeFilePath) {
    return { success: false, error: 'No active file is open.' };
  }

  try {
    const content = await context.extensionContext.services.filesystem.readFile(context.activeFilePath);
    return {
      filePath: context.activeFilePath,
      content,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to read active file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// Helper to parse CSV
function parseCSV(content: string): string[][] {
  return content.split('\n').map(row => row.split(','));
}

export const aiTools: ExtensionAITool[] = [
  {
    name: 'csv.get_schema',
    description: 'Get the column names and row count of the current CSV file',
    scope: 'global',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, context) => {
      const loaded = await loadActiveFile(context);
      if ('success' in loaded) {
        return loaded;
      }

      const rows = parseCSV(loaded.content);
      const headers = rows[0] || [];

      return {
        success: true,
        data: {
          columns: headers,
          rowCount: rows.length - 1,
          filePath: loaded.filePath,
        },
      };
    },
  },

  {
    name: 'csv.get_rows',
    description: 'Get rows from the CSV file. Returns data as objects with column names as keys.',
    inputSchema: {
      type: 'object',
      properties: {
        startRow: {
          type: 'number',
          description: 'Starting row index (0-based, excluding header)',
        },
        count: {
          type: 'number',
          description: 'Number of rows to return (default: 10)',
        },
      },
    },
    handler: async (args, context) => {
      const loaded = await loadActiveFile(context);
      if ('success' in loaded) {
        return loaded;
      }

      const rows = parseCSV(loaded.content);
      const headers = rows[0] || [];
      const dataRows = rows.slice(1);

      const start = typeof args.startRow === 'number' ? args.startRow : 0;
      const count = typeof args.count === 'number' ? args.count : 10;
      const selectedRows = dataRows.slice(start, start + count);

      return {
        success: true,
        data: {
          rows: selectedRows.map(row => {
            const obj: Record<string, string> = {};
            headers.forEach((h, i) => {
              obj[h] = row[i] || '';
            });
            return obj;
          }),
          totalRows: dataRows.length,
        },
      };
    },
  },

  {
    name: 'csv.add_row',
    description: 'Add a new row to the CSV file',
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          description: 'Object with column names as keys and cell values',
        },
      },
      required: ['data'],
    },
    handler: async (args, context) => {
      const loaded = await loadActiveFile(context);
      if ('success' in loaded) {
        return loaded;
      }

      const rows = parseCSV(loaded.content);
      const headers = rows[0] || [];

      // Build new row from data object
      const values = (args.data as Record<string, string>) || {};
      const newRow = headers.map(h => values[h] || '');
      rows.push(newRow);

      const nextContent = rows.map(r => r.join(',')).join('\n');
      await context.extensionContext.services.filesystem.writeFile(
        loaded.filePath,
        nextContent
      );

      return {
        success: true,
        message: `Added a row to ${loaded.filePath}.`,
        data: {
          rowIndex: rows.length - 1,
        },
      };
    },
  },
];
```

## Updating File Content

When a tool needs to modify a file, write through the filesystem service:

```typescript
handler: async (args, context) => {
  // ... modify data ...

  if (!context.activeFilePath) {
    return { success: false, error: 'No active file is open.' };
  }

  await context.extensionContext.services.filesystem.writeFile(
    context.activeFilePath,
    serializedData
  );

  return {
    success: true,
    message: 'Row added successfully',
  };
}
```

Nimbalyst will:
1. Persist the updated file content
2. Notify the active editor through file watching
3. Let the editor reload or reconcile its in-memory state

## Read-Only Tools (`readOnly`)

Editor-scoped tools can run against a file even when it is **not open in a visible tab** — Claude may call your tool against any file in the workspace. To make the editor's imperative API available, the host mounts a hidden instance of your editor on demand. After the tool returns, the host flushes that hidden editor to disk so any mutation it made is persisted.

If your tool only **reads** (it never changes the editor's content), set `readOnly: true`:

```typescript
{
  name: 'myext.get_summary',
  description: 'Summarize the current document. Does not modify it.',
  scope: 'editor',
  readOnly: true,
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    // ...read and return data only...
  },
}
```

Why it matters: the post-run flush is meant to persist *mutations*. For a read-only tool that flush is unnecessary, and if the file was changed out-of-band in the meantime (for example, the agent's own `Edit` to the same file), flushing the hidden editor's now-stale buffer could **overwrite that change**. Declaring `readOnly: true` tells the host to skip the flush entirely.

- Default (unset) is treated as **mutating** — existing tools keep their current behavior.
- Set `readOnly: true` on every tool that only queries/inspects and never writes.
- Tools that read disk directly (via `context.extensionContext.services.filesystem.readFile`) rather than through the editor API are inherently up to date and are the most robust way to serve fresh content to the agent.

## Tool Naming Conventions

Use a prefix for your tools to avoid conflicts:

```
extensionname.action_name
```

Examples:
- `csv.get_schema`
- `csv.add_row`
- `diagram.add_node`
- `datamodel.get_entities`

## Writing Good Tool Descriptions

Claude uses the description to decide when to use your tool. Be specific:

**Good:**
```typescript
description: 'Get the column names and data types from the current CSV file. Returns an array of column definitions.'
```

**Bad:**
```typescript
description: 'Get schema'  // Too vague
```

## Error Handling

Return errors as objects, not thrown exceptions:

```typescript
handler: async (args, context) => {
  if (!context.activeFilePath) {
    return { success: false, error: 'No active file is open' };
  }

  if (!args.columnName) {
    return { success: false, error: 'columnName parameter is required' };
  }

  try {
    // ... do work ...
    return { success: true, data: result };
  } catch (e) {
    return { error: `Failed to process: ${e.message}` };
  }
}
```

## Input Schema

The `inputSchema` follows JSON Schema format:

```typescript
inputSchema: {
  type: 'object',
  properties: {
    // String parameter
    name: {
      type: 'string',
      description: 'The name to use',
    },

    // Number parameter
    count: {
      type: 'number',
      description: 'How many items',
    },

    // Boolean parameter
    includeHeaders: {
      type: 'boolean',
      description: 'Whether to include header row',
    },

    // Enum parameter
    format: {
      type: 'string',
      enum: ['json', 'csv', 'xml'],
      description: 'Output format',
    },

    // Array parameter
    columns: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of column names',
    },

    // Object parameter
    options: {
      type: 'object',
      properties: {
        sortBy: { type: 'string' },
        ascending: { type: 'boolean' },
      },
    },
  },
  required: ['name'], // Required parameters
}
```

## Best Practices

1. **Keep tools focused** - One tool, one job
2. **Return structured data** - Objects are easier for Claude to work with
3. **Include context in responses** - Return relevant metadata
4. **Handle missing files gracefully** - Check if `activeFilePath` exists and read through the filesystem service
5. **Validate inputs** - Check required parameters
6. **Use descriptive names** - `get_column_stats` not `stats`

## Testing Tools

Test your tools by asking Claude to use them:

> "What columns are in this CSV file?"

Claude should invoke your `csv.get_schema` tool and report the results.

## Example: Data Model Tools

For a more complex example, here are tools for a data modeling extension:

```typescript
export const aiTools: ExtensionAITool[] = [
  {
    name: 'datamodel.get_entities',
    description: 'List all entities (tables/models) defined in the data model',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      if (!context.activeFilePath) {
        return { success: false, error: 'No active file is open' };
      }

      const content = await context.extensionContext.services.filesystem.readFile(
        context.activeFilePath
      );
      const model = parseDataModel(content);

      return {
        success: true,
        data: {
          entities: model.entities.map(e => ({
            name: e.name,
            fieldCount: e.fields.length,
          })),
        },
      };
    },
  },

  {
    name: 'datamodel.get_entity',
    description: 'Get detailed information about a specific entity',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Entity name' },
      },
      required: ['name'],
    },
    handler: async (args, context) => {
      if (!context.activeFilePath) {
        return { success: false, error: 'No active file is open' };
      }

      const content = await context.extensionContext.services.filesystem.readFile(
        context.activeFilePath
      );
      const model = parseDataModel(content);
      const entity = model.entities.find(e => e.name === args.name);

      if (!entity) {
        return { success: false, error: `Entity '${args.name}' not found` };
      }

      return {
        success: true,
        data: {
          name: entity.name,
          fields: entity.fields.map(f => ({
            name: f.name,
            type: f.type,
            required: f.required,
          })),
          relations: entity.relations,
        },
      };
    },
  },

  {
    name: 'datamodel.add_field',
    description: 'Add a new field to an entity',
    inputSchema: {
      type: 'object',
      properties: {
        entityName: { type: 'string' },
        fieldName: { type: 'string' },
        fieldType: { type: 'string' },
        required: { type: 'boolean' },
      },
      required: ['entityName', 'fieldName', 'fieldType'],
    },
    handler: async (args, context) => {
      if (!context.activeFilePath) {
        return { success: false, error: 'No active file is open' };
      }

      const content = await context.extensionContext.services.filesystem.readFile(
        context.activeFilePath
      );
      const model = parseDataModel(content);
      const entity = model.entities.find(e => e.name === args.entityName);

      if (!entity) {
        return { success: false, error: `Entity '${args.entityName}' not found` };
      }

      entity.fields.push({
        name: args.fieldName,
        type: args.fieldType,
        required: args.required ?? false,
      });

      await context.extensionContext.services.filesystem.writeFile(
        context.activeFilePath,
        serializeDataModel(model)
      );

      return {
        success: true,
        message: `Added ${args.fieldName} to ${args.entityName}.`,
      };
    },
  },
];
```

## Calling AI Models Directly

Extensions can also call AI chat/completion models directly, without going through Claude. This is useful for summarization, classification, code generation, or any task where the extension itself needs an AI response.

### Prerequisites

Your manifest must declare `permissions.ai: true`.

### Listing Available Models

```typescript
export async function activate(context: ExtensionContext) {
  const models = await context.services.ai!.listModels();
  // => [
  //   { id: "claude:claude-sonnet-4-6-20250514", name: "Claude Sonnet 4.6", provider: "claude" },
  //   { id: "openai:gpt-4o", name: "GPT-4o", provider: "openai" },
  //   ...
  // ]
}
```

Only models from chat providers the user has enabled and configured are returned (Claude, OpenAI, LM Studio). Agent providers like Claude Code are not included.

### Non-Streaming Completion

```typescript
const result = await context.services.ai!.chatCompletion({
  messages: [
    { role: 'user', content: 'Classify this text as positive or negative: "Great product!"' },
  ],
  model: 'claude:claude-sonnet-4-6-20250514', // optional, uses default if omitted
  systemPrompt: 'Respond with a single word: positive or negative.',
  temperature: 0,
  maxTokens: 10,
});

console.log(result.content);  // "positive"
console.log(result.model);    // "claude-sonnet-4-6-20250514"
console.log(result.usage);    // { inputTokens: 42, outputTokens: 1 }
```

### Streaming Completion

For longer responses where you want to show results incrementally:

```typescript
const handle = await context.services.ai!.chatCompletionStream({
  messages: [
    { role: 'user', content: 'Write a haiku about programming' },
  ],
  onChunk: (chunk) => {
    if (chunk.type === 'text') {
      // Append text to your UI
      appendToOutput(chunk.content!);
    } else if (chunk.type === 'error') {
      showError(chunk.error!);
    }
    // chunk.type === 'done' means the stream is complete
  },
});

// Optionally abort:
// handle.abort();

// Wait for the full result:
const result = await handle.result;
console.log(result.content); // Full response text
```

### Multi-Turn Conversations

Pass multiple messages for conversation context:

```typescript
const result = await context.services.ai!.chatCompletion({
  messages: [
    { role: 'user', content: 'What is the capital of France?' },
    { role: 'assistant', content: 'The capital of France is Paris.' },
    { role: 'user', content: 'What is its population?' },
  ],
});
```

### Structured Output (JSON Mode)

Use `responseFormat` to constrain the model's output to valid JSON:

```typescript
// Simple JSON mode - model returns valid JSON
const result = await context.services.ai!.chatCompletion({
  messages: [{ role: 'user', content: 'List 3 colors with hex codes' }],
  systemPrompt: 'Respond in JSON format.',
  responseFormat: { type: 'json_object' },
});
const data = JSON.parse(result.content);
```

For stricter control, use `json_schema` to enforce a specific shape:

```typescript
const result = await context.services.ai!.chatCompletion({
  messages: [{ role: 'user', content: 'Classify this issue: login page crashes on Safari' }],
  responseFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['bug', 'feature', 'question'] },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        component: { type: 'string' },
      },
      required: ['category', 'severity', 'component'],
    },
  },
});
const classification = JSON.parse(result.content);
// => { category: "bug", severity: "high", component: "auth" }
```

### Key Points

- **Stateless**: These calls do not create sessions in the session history. Each call is independent.
- **Model selection**: Use `listModels()` to discover available models, then pass an `id` to `chatCompletion()` or `chatCompletionStream()`. If you omit the model, the first available provider's default is used.
- **Chat providers only**: Claude, OpenAI, and LM Studio. Agent providers (Claude Code, Codex) are not available through this API.
- **User configuration**: The API respects the user's provider settings and API keys. If a provider is disabled or unconfigured, its models won't appear in `listModels()`.

## Next Steps

- See [custom-editors.md](./custom-editors.md) to build the visual component
- Check [manifest-reference.md](./manifest-reference.md) for all configuration options
- Look at [examples/ai-tool](./examples/ai-tool/) for a complete working example
- See [api-reference.md](./api-reference.md) for full type definitions
