/**
 * DatamodelLM AI Tools
 *
 * AI tools for interacting with the data model editor.
 *
 * Note: Schema editing (create/update/delete entity/relationship) is now handled
 * by Claude directly editing the Prisma schema file. These tools provide
 * read-only access and screenshot capture functionality.
 */

import type { DataModelStoreApi } from './store';

/**
 * Get the store from the tool context's central editor API registry.
 */
function getStore(context: { editorAPI?: unknown }): DataModelStoreApi | null {
  return (context.editorAPI as DataModelStoreApi) ?? null;
}

/**
 * AI Tool definitions for DatamodelLM
 *
 * Schema manipulation is handled by editing the .prisma file directly.
 * These tools provide supplementary functionality.
 */
export const aiTools = [
  {
    name: 'get_schema',
    access: { kind: 'editor-read' } as const,
    description: `Get the current data model schema. Use this to understand the existing entities and relationships before making changes.

Example usage:
- "What tables exist?"
- "Show me the current schema"
- "What fields does User have?"`,
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (_params: Record<string, never>, context: { activeFilePath?: string; editorAPI?: unknown }) => {
      const store = getStore(context);
      if (!store) {
        return {
          success: false,
          error: 'No active data model editor found. Please open a .prisma file first.',
        };
      }

      const state = store.getState();
      const { entities, relationships, database } = state;

      const schema = {
        database,
        entities: entities.map(e => ({
          name: e.name,
          description: e.description,
          fields: e.fields.map(f => ({
            name: f.name,
            type: f.dataType,
            isPrimaryKey: f.isPrimaryKey,
            isForeignKey: f.isForeignKey,
            isNullable: f.isNullable,
            isArray: f.isArray,
            isEmbedded: f.isEmbedded,
          })),
        })),
        relationships: relationships.map(r => ({
          from: `${r.sourceEntityName}.${r.sourceFieldName || 'id'}`,
          to: `${r.targetEntityName}.${r.targetFieldName || 'id'}`,
          type: r.type,
        })),
      };

      return {
        success: true,
        message: `Found ${entities.length} entities and ${relationships.length} relationships.`,
        data: schema,
      };
    },
  },

  {
    name: 'capture_screenshot',
    access: { kind: 'editor-read' } as const,
    description: `Capture a screenshot of the current data model diagram. Use this when the user wants to see or share the visual representation of their schema.

Example usage:
- "Show me the diagram"
- "Take a screenshot of the data model"
- "Let me see how this looks"`,
    parameters: {
      type: 'object' as const,
      properties: {},
    },
    handler: async (_params: Record<string, never>, context: { activeFilePath?: string; editorAPI?: unknown }) => {
      const store = getStore(context);
      if (!store) {
        return {
          success: false,
          error: 'No active data model editor found. Please open a .prisma file first.',
        };
      }

      // The screenshot will be captured by the extension platform
      // We return a special response that triggers screenshot capture
      return {
        success: true,
        message: 'Screenshot capture requested.',
        captureScreenshot: true,
        data: {
          filePath: context.activeFilePath,
          entityCount: store.getState().entities.length,
        },
      };
    },
  },
];
