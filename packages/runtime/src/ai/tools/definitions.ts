/**
 * Tool definitions: schemas, the registry, and the provider serializers.
 *
 * This module must stay free of editor imports. The AI server layer
 * (`AIProvider`, the providers, `SessionManager`) only ever needs to
 * *describe* tools to a model, so it imports from here. The handlers that
 * actually drive a live editor live in `./documentEditingExecutor`, which
 * only the renderer pulls in — a headless host simply has no editor, so
 * those tools are absent from its topology rather than broken.
 */

import { FILE_TOOLS } from './fileTools';
import { DOCUMENT_TOOLS } from './documentTools';

export type ToolSource = 'runtime' | 'renderer' | 'main';

/**
 * Context passed alongside `args` when a tool's handler runs. Carries
 * workspace identity so handlers that need to resolve workspace-scoped
 * services (e.g. file system access for the multi-project rail) do not
 * have to fall back to a runtime-global singleton, which would route
 * through the currently-visible workspace instead of the session's own.
 */
export interface ToolContext {
  workspacePath?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler?: (args: any, context?: ToolContext) => Promise<any> | any;
  source?: ToolSource;
}

export const BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: 'applyDiff',
    description:
      'Apply text replacements to a markdown document or a collaborative shared document. IMPORTANT: Only .md files or collab:// URIs can be modified. REQUIRED for adding rows to tables - replace the entire table. If no filePath is provided, applies to the currently active document.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Optional absolute path to a markdown file (.md) or a collab:// URI for a shared document. If not provided, applies to the currently active document.',
        },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: {
                type: 'string',
                description:
                  'Text to replace (for tables: the COMPLETE existing table including all rows)',
              },
              newText: {
                type: 'string',
                description:
                  'Replacement text (for tables: the COMPLETE updated table with new rows added)',
              },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['replacements'],
    },
    source: 'runtime',
  },
  {
    name: 'streamContent',
    description:
      'Stream new content to the editor. For tables: set insertAfter to the COMPLETE table, content to ONLY the new rows.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to stream (for tables: ONLY the new rows like "| Cell1 | Cell2 |")',
        },
        position: {
          type: 'string',
          enum: ['cursor', 'end', 'after-selection'],
          description: 'Where to insert content. MUST be exactly one of: "cursor" (at cursor position), "end" (at end of document), or "after-selection" (after selected text). Use "end" for appending to document.',
        },
        insertAfter: {
          type: 'string',
          description:
            'Text to insert after (for tables: the COMPLETE table including all rows)',
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace', 'insert'],
          description: 'How to handle the content',
        },
      },
      required: ['content'],
    },
    source: 'runtime',
  },
  // Add document tools
  ...DOCUMENT_TOOLS,
  // Add file operation tools
  ...FILE_TOOLS,
];

type ToolRegistryEventName = 'tool:registered' | 'tool:unregistered';

type ToolRegistryEventListener = (tool: ToolDefinition) => void;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private listeners = new Map<ToolRegistryEventName, Set<ToolRegistryEventListener>>();

  constructor(initialTools: ToolDefinition[] = BUILT_IN_TOOLS) {
    initialTools.forEach(tool => this.tools.set(tool.name, tool));
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.emit('tool:registered', tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    tools.forEach(tool => this.register(tool));
  }

  unregister(toolName: string): void {
    const tool = this.tools.get(toolName);
    if (tool) {
      this.tools.delete(toolName);
      this.emit('tool:unregistered', tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  clear(): void {
    this.tools.clear();
  }

  toOpenAI(): any[] {
    return toOpenAITools(this.getAll());
  }

  toAnthropic(): any[] {
    return toAnthropicTools(this.getAll());
  }

  on(event: ToolRegistryEventName, listener: ToolRegistryEventListener): void {
    const listeners = this.listeners.get(event) ?? new Set<ToolRegistryEventListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: ToolRegistryEventName, listener: ToolRegistryEventListener): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.listeners.delete(event);
    }
  }

  private emit(event: ToolRegistryEventName, tool: ToolDefinition): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    listeners.forEach(listener => listener(tool));
  }
}

export const toolRegistry = new ToolRegistry();

export function toOpenAITools(tools: ToolDefinition[]): any[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export function toAnthropicTools(tools: ToolDefinition[]): any[] {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}
