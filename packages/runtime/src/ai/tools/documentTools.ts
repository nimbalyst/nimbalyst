import type { ToolDefinition } from './index';

export const DOCUMENT_TOOLS: ToolDefinition[] = [
  {
    name: 'getDocumentContent',
    description: 'Get the content of a specific markdown document. IMPORTANT: You must provide the absolute file path.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'REQUIRED: Absolute path to the markdown file to read content from',
        },
      },
      required: ['filePath'],
    },
    source: 'runtime',
  },
  {
    name: 'updateFrontmatter',
    description: 'Update the frontmatter of a specific markdown document with new metadata. IMPORTANT: You must provide the absolute file path.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'REQUIRED: Absolute path to the markdown file to update',
        },
        updates: {
          type: 'object',
          description: 'Key-value pairs to update in the frontmatter (e.g., { status: "completed", title: "My Document" })',
          additionalProperties: true,
        },
      },
      required: ['filePath', 'updates'],
    },
    source: 'runtime',
  },
  {
    name: 'createDocument',
    description: 'Create a new document file and switch the editor to it. Use this when you need to create new documentation or files in specific folders.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path from workspace root where to create the file (e.g., "docs/user-guide.md" or "plans/new-feature.md")',
        },
        initialContent: {
          type: 'string',
          description: 'Initial content for the file. If not provided, file will be created empty.',
        },
        switchToFile: {
          type: 'boolean',
          description: 'Whether to switch the editor to the newly created file (default: true)',
        },
      },
      required: ['filePath'],
    },
    source: 'runtime',
  },
];