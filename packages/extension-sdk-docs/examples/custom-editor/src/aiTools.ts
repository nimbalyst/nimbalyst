/**
 * AI Tools for JSON Viewer
 *
 * These tools let Claude interact with JSON data programmatically.
 */

import type { AIToolContext, ExtensionAITool, ExtensionToolResult } from '@nimbalyst/extension-sdk';

async function loadActiveJson(context: AIToolContext): Promise<{
  filePath: string;
  data: unknown;
} | ExtensionToolResult> {
  if (!context.activeFilePath) {
    return { success: false, error: 'No active file is open.' };
  }

  try {
    const content = await context.extensionContext.services.filesystem.readFile(context.activeFilePath);
    return {
      filePath: context.activeFilePath,
      data: JSON.parse(content),
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to load JSON file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const aiTools: ExtensionAITool[] = [
  {
    name: 'json.get_structure',
    description: 'Get the structure of the JSON document showing keys and types at each level',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: {
          type: 'number',
          description: 'Maximum depth to traverse (default: 3)',
        },
      },
    },
    handler: async (args, context): Promise<ExtensionToolResult> => {
      const loaded = await loadActiveJson(context);
      if ('success' in loaded) {
        return loaded;
      }

      try {
        const data = loaded.data;
        const maxDepth = typeof args.maxDepth === 'number' ? args.maxDepth : 3;

        const getStructure = (value: unknown, depth: number): unknown => {
          if (depth > maxDepth) return '...';

          if (value === null) return 'null';
          if (Array.isArray(value)) {
            if (value.length === 0) return '[]';
            return [getStructure(value[0], depth + 1)];
          }
          if (typeof value === 'object') {
            const result: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value)) {
              result[k] = getStructure(v, depth + 1);
            }
            return result;
          }
          return typeof value;
        };

        return {
          success: true,
          message: 'Retrieved JSON structure.',
          data: {
            filePath: loaded.filePath,
            structure: getStructure(data, 0),
          },
        };
      } catch (e) {
        return { success: false, error: `Failed to parse JSON: ${(e as Error).message}` };
      }
    },
  },

  {
    name: 'json.get_value',
    description: 'Get the value at a specific path in the JSON document',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Dot-notation path (e.g., "users.0.name")',
        },
      },
      required: ['path'],
    },
    handler: async (args, context): Promise<ExtensionToolResult> => {
      const loaded = await loadActiveJson(context);
      if ('success' in loaded) {
        return loaded;
      }

      if (typeof args.path !== 'string') {
        return { success: false, error: 'path must be a string.' };
      }

      try {
        const data = loaded.data;
        const pathParts = args.path.split('.');

        let current: unknown = data;
        for (const part of pathParts) {
          if (current === undefined || current === null) {
            return { success: false, error: `Path not found: ${args.path}` };
          }
          current = (current as Record<string, unknown>)[part];
        }

        return {
          success: true,
          message: `Retrieved JSON value at ${args.path}.`,
          data: {
            path: args.path,
            value: current,
            type: Array.isArray(current) ? 'array' : typeof current,
          },
        };
      } catch (e) {
        return { success: false, error: `Failed to parse JSON: ${(e as Error).message}` };
      }
    },
  },

  {
    name: 'json.set_value',
    description: 'Set the value at a specific path in the JSON document',
    access: { kind: 'filesystem' },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Dot-notation path (e.g., "users.0.name")',
        },
        value: {
          type: 'object',
          description: 'The new value to set (any JSON-compatible type)',
        },
      },
      required: ['path', 'value'],
    },
    handler: async (args, context): Promise<ExtensionToolResult> => {
      const loaded = await loadActiveJson(context);
      if ('success' in loaded) {
        return loaded;
      }

      if (typeof args.path !== 'string') {
        return { success: false, error: 'path must be a string.' };
      }

      try {
        const data = loaded.data as Record<string, unknown>;
        const pathParts = args.path.split('.');

        // Navigate to parent
        let current: Record<string, unknown> = data;
        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (current[part] === undefined) {
            // Create intermediate objects/arrays as needed
            const nextPart = pathParts[i + 1];
            current[part] = isNaN(Number(nextPart)) ? {} : [];
          }
          current = current[part] as Record<string, unknown>;
        }

        // Set the value
        const lastPart = pathParts[pathParts.length - 1];
        const oldValue = current[lastPart];
        current[lastPart] = args.value;
        const nextContent = JSON.stringify(data, null, 2);
        await context.extensionContext.services.filesystem.writeFile(loaded.filePath, nextContent);

        return {
          success: true,
          message: `Updated ${args.path} in ${loaded.filePath}.`,
          data: {
            path: args.path,
            oldValue,
            newValue: args.value,
          },
        };
      } catch (e) {
        return { success: false, error: `Failed to update JSON: ${(e as Error).message}` };
      }
    },
  },
];
