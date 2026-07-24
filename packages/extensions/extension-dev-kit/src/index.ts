/**
 * Extension Developer Kit
 *
 * Provides slash commands for creating and developing Nimbalyst extensions.
 */

import { templates } from './templates';

const LEGACY_TEMPLATES = new Set(['starter', 'minimal', 'custom-editor', 'ai-tool']);
const DEFAULT_TEMPLATE = 'starter';

// No UI components
export const components = {};

/**
 * /new-extension slash command handler
 *
 * Creates a new extension project from a starter scaffold.
 * Arguments: <path> <name> [filePatterns]
 *
 * Examples:
 *   /new-extension ~/projects/my-ext "My Extension"
 *   /new-extension ~/projects/csv-editor "CSV Editor" *.csv,*.tsv
 *   /new-extension ~/projects/text-stats "Text Stats"
 */
export async function newExtensionCommand(args: string): Promise<string> {
  const parsed = parseArgs(args);

  if (!parsed) {
    return `## /new-extension - Create a New Extension Project

**Usage:**
\`\`\`
/new-extension <path> <name> [filePatterns]
\`\`\`

This creates a neutral starter scaffold. After that, describe the extension you want and Claude can shape the scaffold into a custom editor, AI tool extension, panel, or something more specific.

**Arguments:**
- \`path\` - Directory path where the project will be created
- \`name\` - Display name for the extension (in quotes if it has spaces)
- \`filePatterns\` - Optional comma-separated file patterns like \`*.csv,*.tsv\`

**Legacy usage still works:**
\`\`\`
/new-extension <template> <path> <name> [filePatterns]
\`\`\`

**Examples:**
\`\`\`
/new-extension ~/projects/hello-ext "Hello Extension"
/new-extension ~/projects/csv-editor "CSV Editor" *.csv,*.tsv
/new-extension starter ~/projects/word-stats "Word Stats"
\`\`\`

**After creating the project:**
1. Open the project folder in Nimbalyst
2. Describe the extension you want Claude to build
3. Ask Claude to implement it, then build and install it
4. Claude will use the \`extension_build\` and \`extension_install\` tools

**Note:** Make sure "Extension Dev Tools" is enabled in Settings > Advanced.`;
  }

  const { template, projectPath, name, filePatterns } = parsed;

  // Validate template
  if (!(template in templates)) {
    return `Error: Unknown template "${template}". Use one of: ${Object.keys(templates).join(', ')}`;
  }

  // Generate extension ID from name
  const extensionId = `com.developer.${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  // Get the template generator
  const templateFn = templates[template as keyof typeof templates];
  if (!templateFn) {
    return `Error: Template "${template}" not found.`;
  }

  // Generate the project files
  const files = templateFn({
    name,
    extensionId,
    filePatterns: filePatterns ? [filePatterns] : ['*.example'],
  });

  // Return instructions for Claude to create the files
  return `## Create Extension Project: ${name}

Please create the following files in \`${projectPath}\`:

${Object.entries(files)
  .map(
    ([filePath, content]) => `### ${filePath}
\`\`\`${getLanguage(filePath)}
${content}
\`\`\``
  )
  .join('\n\n')}

**After creating these files:**
1. Run \`npm install\` in the project directory
2. Use the \`extension_build\` tool to build the extension
3. Use the \`extension_install\` tool to install it into Nimbalyst

The extension will handle files matching: ${filePatterns || '*.example'}`;
}

/**
 * Parse command arguments
 */
function parseArgs(
  args: string
): { template: string; projectPath: string; name: string; filePatterns?: string } | null {
  if (!args.trim()) {
    return null;
  }

  const legacyMatch = args.match(
    /^(\S+)\s+(\S+)\s+(?:"([^"]+)"|(\S+))(?:\s+(\S+))?$/
  );

  if (legacyMatch && LEGACY_TEMPLATES.has(legacyMatch[1])) {
    const [, template, projectPath, quotedName, unquotedName, filePatterns] = legacyMatch;
    return {
      template,
      projectPath,
      name: quotedName || unquotedName,
      filePatterns,
    };
  }

  const defaultMatch = args.match(
    /^(\S+)\s+(?:"([^"]+)"|(\S+))(?:\s+(\S+))?$/
  );

  if (!defaultMatch) {
    return null;
  }

  const [, projectPath, quotedName, unquotedName, filePatterns] = defaultMatch;

  return {
    template: DEFAULT_TEMPLATE,
    projectPath,
    name: quotedName || unquotedName,
    filePatterns,
  };
}

/**
 * Get language for syntax highlighting based on file extension
 */
function getLanguage(filePath: string): string {
  if (filePath.endsWith('.json')) return 'json';
  if (filePath.endsWith('.ts')) return 'typescript';
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.css')) return 'css';
  return '';
}

// Export slash command handlers
export const slashCommandHandlers = {
  newExtensionCommand,
};

// Lifecycle
export function activate() {
  console.log('Extension Developer Kit activated');
}

export function deactivate() {
  console.log('Extension Developer Kit deactivated');
}
