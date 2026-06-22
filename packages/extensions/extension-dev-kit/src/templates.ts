/**
 * Extension project templates
 *
 * Each template returns a map of file paths to file contents.
 */

interface TemplateOptions {
  name: string;
  extensionId: string;
  filePatterns: string[];
}

type TemplateFiles = Record<string, string>;

const SDK_VERSION = '^0.1.0';

/**
 * Generate CLAUDE.md content for a new extension project.
 *
 * This gives AI agents (Claude Code, etc.) the context they need to
 * understand, build, and iterate on a Nimbalyst extension.
 */
function generateClaudeMd(options: TemplateOptions & { template: string }): string {
  const { name, extensionId, filePatterns, template } = options;
  const hasEditor = template === 'minimal' || template === 'custom-editor';
  const hasAiTools = template === 'custom-editor' || template === 'ai-tool';
  const entryPointExports = ['components'];

  if (hasAiTools) {
    entryPointExports.push('aiTools');
  }

  entryPointExports.push('activate()', 'deactivate()');

  const sections: string[] = [];

  // Header
  sections.push(`# ${name} -- Nimbalyst Extension

This is a **Nimbalyst extension** project. Nimbalyst is an extensible, AI-native workspace and code editor. Extensions add custom editors, AI tools, panels, themes, and more.

- **Extension ID**: \`${extensionId}\`
- **Template**: \`${template}\`
- **File patterns**: ${filePatterns.map(p => `\`${p}\``).join(', ')}`);

  sections.push(`## Documentation

Use these docs in this order:

1. **Bundled SDK docs in packaged Nimbalyst**
   - Cross-platform runtime path: \`path.join(process.resourcesPath, 'extension-sdk-docs')\`
   - macOS example: \`/Applications/Nimbalyst.app/Contents/Resources/extension-sdk-docs\`
   - Windows example: \`<Nimbalyst install dir>\\\\resources\\\\extension-sdk-docs\`
2. **Monorepo source docs** (when developing inside the Nimbalyst repo)
   - \`packages/extension-sdk-docs/README.md\`
   - \`packages/extension-sdk-docs/getting-started.md\`
   - \`packages/extension-sdk-docs/custom-editors.md\`
   - \`packages/extension-sdk-docs/ai-tools.md\`
   - \`packages/extension-sdk-docs/manifest-reference.md\`
   - \`packages/extension-sdk-docs/api-reference.md\`
   - \`packages/extension-sdk-docs/examples/\`
3. **Hosted docs**
   - \`https://docs.nimbalyst.com/extensions\`

When examples are more helpful than prose, prefer the example projects in \`packages/extension-sdk-docs/examples/\` and the built-in extensions in \`packages/extensions/\`.`);

  // Build workflow
  sections.push(`## Build and Development Workflow

Extensions are built with Vite and installed into the running Nimbalyst app using MCP tools. **Do not run \`npm run build\` manually** -- always use the MCP tools so the extension is installed in one step.

| Action | MCP Tool |
| --- | --- |
| Build | \`mcp__nimbalyst-extension-dev__extension_build\` |
| Install | \`mcp__nimbalyst-extension-dev__extension_install\` |
| Build + reinstall (hot reload) | \`mcp__nimbalyst-extension-dev__extension_reload\` |
| Check status | \`mcp__nimbalyst-extension-dev__extension_get_status\` |
| Uninstall | \`mcp__nimbalyst-extension-dev__extension_uninstall\` |

**Typical iteration loop:**
1. Edit source files
2. Run \`extension_reload\` with \`extensionId: "${extensionId}"\` and \`path\` set to this project root
3. Test in Nimbalyst immediately

**First-time setup:**
1. \`npm install\` in this directory
2. \`extension_build\` then \`extension_install\`
3. When the extension can be exercised with a sample file, create one and open it to test the integration end-to-end

### After Installation

- Tell the user the extension is now installed in Nimbalyst
- Explain that installed extensions are available across all of their Nimbalyst projects, not just this workspace
- When possible, create a representative sample file for the extension and present it to the user for testing immediately after install or reload

### Debugging

- Check extension load status: \`extension_get_status\` with \`extensionId: "${extensionId}"\`
- Main process logs: \`mcp__nimbalyst-extension-dev__get_main_process_logs\` (filter by component: "EXTENSION")
- Renderer logs: \`mcp__nimbalyst-extension-dev__get_renderer_debug_logs\`
- Verify the result visually: \`mcp__nimbalyst__capture_editor_screenshot\`

### Testing with Playwright

Run Playwright tests against the live running Nimbalyst instance using the \`extension_test_run\` MCP tool. Tests connect via CDP -- no separate Electron launch needed.

**Inline script (quick check):**
\`\`\`
extension_test_run({ script: "await expect(page.locator('[data-extension-id=\\"${extensionId}\\"]')).toBeVisible();" })
\`\`\`

**Test file (persistent tests):**
\`\`\`
extension_test_run({ testFile: "<project-root>/tests/basics.spec.ts" })
\`\`\`

**Open a file first:**
\`\`\`
extension_test_open_file({ filePath: "/path/to/sample.ext", waitForExtension: "${extensionId}" })
\`\`\`

Tests use the full Playwright API -- locators, assertions, interactions, screenshots. See \`tests/\` for examples.`);

  // Project structure
  sections.push(`## Project Structure

\`\`\`
manifest.json      # Extension manifest -- declares capabilities, contributions, permissions
package.json       # NPM package with build script
vite.config.ts     # Vite build config (uses @nimbalyst/extension-sdk/vite helper)
tsconfig.json      # TypeScript config
src/
  index.ts         # Entry point -- exports ${entryPointExports.join(', ')}${hasEditor ? `
  *Editor.tsx      # Custom editor React component` : ''}${hasAiTools ? `
  aiTools.ts       # AI tool definitions` : ''}
tests/
  basics.spec.ts   # Playwright extension tests (run via extension_test_run)
dist/              # Build output (do not edit)
\`\`\``);

  // Manifest
  sections.push(`## Manifest (\`manifest.json\`)

The manifest declares what the extension contributes to Nimbalyst. Key fields:

- **\`contributions.customEditors\`** -- Register editors for file patterns
- **\`contributions.aiTools\`** -- List AI tool names (must match the \`name\` field in your tool definitions)
- **\`contributions.newFileMenu\`** -- Add entries to File > New menu
- **\`contributions.fileIcons\`** -- Custom icons for file types
- **\`contributions.panels\`** -- Sidebar or bottom panels
- **\`contributions.commands\`** -- Commands with optional keybindings
- **\`contributions.themes\`** -- Color themes (see [EXTENSION_THEMING.md](../../docs/EXTENSION_THEMING.md); manifest-only theme extensions are supported)
- **\`contributions.claudePlugin\`** -- Claude Code agent skills and slash commands (see below)
- **\`permissions\`** -- Request \`filesystem\`, \`ai\`, or \`network\` access`);

  // EditorHost contract
  if (hasEditor) {
    sections.push(`## useEditorLifecycle Hook

Use the \`useEditorLifecycle\` hook from \`@nimbalyst/extension-sdk\` to handle all editor lifecycle concerns. It replaces manual \`useEffect\` subscriptions for loading, saving, file watching, echo detection, dirty state, diff mode, and theme tracking.

\`\`\`typescript
import { useRef } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

function MyEditor({ host }: EditorHostProps) {
  const dataRef = useRef<MyData>(defaultData);

  const { isLoading, error, theme, markDirty, diffState } = useEditorLifecycle(host, {
    applyContent: (data: MyData) => { dataRef.current = data; },
    getCurrentContent: () => dataRef.current,
    parse: (raw) => JSON.parse(raw),        // raw file string -> editor format
    serialize: (data) => JSON.stringify(data), // editor format -> file string
  });

  if (isLoading) return <div>Loading...</div>;
  return <MyEditorUI data={dataRef.current} onChange={markDirty} />;
}
\`\`\`

The hook uses pull/push callbacks -- content **never** lives in React state:
- **\`applyContent\`**: push content INTO the editor (on load, external change)
- **\`getCurrentContent\`**: pull content FROM the editor (on save)

**Key rules:**
- The editor owns its content state. The parent never stores or passes content.
- Never depend on the parent re-rendering your component.
- Use the \`theme\` return value (reactive) for theme-aware rendering.
- Use \`host.storage\` for persisting editor-specific state (workspace-scoped or global).
- For editors with async content extraction, use \`onSave\` override instead of \`getCurrentContent\`.
- For editors with specialized diff rendering, use \`onDiffRequested\` / \`onDiffCleared\` overrides.`);
  }

  // AI tools
  if (hasAiTools) {
    sections.push(`## AI Tools

AI tools let Claude interact with your extension programmatically. Define tools in \`src/aiTools.ts\` (or \`src/index.ts\` for ai-tool template) and export them as \`aiTools\`.

\`\`\`typescript
import type { ExtensionAITool, ExtensionToolResult } from '@nimbalyst/extension-sdk';

export const aiTools: ExtensionAITool[] = [
  {
    name: 'myext.do_something',     // prefix.action_name
    description: 'Describe what it does -- Claude reads this to decide when to use it',
    scope: 'global',                // 'global' = always available, 'editor' = only when file is open
    inputSchema: {
      type: 'object',
      properties: { /* JSON Schema */ },
      required: [],
    },
    handler: async (args, context): Promise<ExtensionToolResult> => {
      // context.activeFilePath -- current file
      // context.workspacePath -- workspace root
      // context.extensionContext.services.filesystem -- read/write files
      return { success: true, message: 'Done', data: { /* structured result */ } };
    },
  },
];
\`\`\`

**Best practices:**
- Prefix tool names with your extension name to avoid collisions
- Write specific descriptions -- Claude uses them to decide when to call the tool
- Return structured data in \`data\`, not just messages
- Return errors as \`{ success: false, error: '...' }\` -- do not throw
- Every tool listed in \`manifest.json contributions.aiTools\` must have a matching handler`);
  }

  // Claude Plugin (agent skills)
  sections.push(`## Claude Agent Skills (\`claudePlugin\`)

Extensions can bundle **Claude Code skills** -- slash commands and agent context that enhance the AI agent's capabilities within Nimbalyst.

### Directory structure

\`\`\`
claude-plugin/
  .claude-plugin/
    plugin.json          # Plugin metadata
  commands/
    my-command.md        # Slash command (user types /my-command)
  skills/
    my-skill/
      SKILL.md           # Skill definition (auto-triggered by agent)
\`\`\`

### Register in manifest.json

\`\`\`json
{
  "contributions": {
    "claudePlugin": {
      "path": "claude-plugin",
      "displayName": "${name}",
      "description": "What the plugin provides to the agent",
      "enabledByDefault": true,
      "commands": [
        { "name": "my-command", "description": "What /my-command does" }
      ]
    }
  }
}
\`\`\`

### plugin.json

\`\`\`json
{
  "name": "${extensionId.replace(/\./g, '-')}",
  "version": "1.0.0",
  "description": "Claude Code plugin for ${name}",
  "keywords": []
}
\`\`\`

### Slash command (\`commands/my-command.md\`)

\`\`\`markdown
---
description: Short description shown in command palette
---

# /my-command

Detailed instructions for Claude when the user invokes /my-command.

The user said: $ARGUMENTS
\`\`\`

### Skill (\`skills/my-skill/SKILL.md\`)

Skills are automatically loaded when their description matches the task. They provide domain context and tool usage instructions.

\`\`\`markdown
---
name: my-skill
description: When and why the agent should use this skill (be specific so it triggers correctly)
---

# Skill Name

Instructions for the agent, including which MCP tools to use and in what order.
\`\`\``);

  // CSS theming
  if (hasEditor) {
    sections.push(`## CSS Theming

Use Nimbalyst's CSS custom properties for theme-consistent styling:

| Variable | Usage |
| --- | --- |
| \`--nim-bg\` | Primary background |
| \`--nim-bg-secondary\` | Secondary background (panels, inputs) |
| \`--nim-bg-tertiary\` | Tertiary background (hover states) |
| \`--nim-bg-hover\` | Hover background |
| \`--nim-text\` | Primary text |
| \`--nim-text-muted\` | Secondary text |
| \`--nim-text-faint\` | Tertiary text |
| \`--nim-border\` | Borders |
| \`--nim-primary\` | Accent / primary actions |
| \`--nim-success\` / \`--nim-warning\` / \`--nim-error\` | Status colors |

Always use these variables instead of hardcoded colors so the extension works with all themes.`);
  }

  // SDK reference
  sections.push(`## SDK Reference

The \`@nimbalyst/extension-sdk\` package provides types and the Vite build helper.
The \`@nimbalyst/extension-sdk\` package also re-exports the \`useEditorLifecycle\` hook (provided by the host at runtime -- do not add \`@nimbalyst/runtime\` to package.json).

Key imports:
\`\`\`typescript
// Types from SDK
import type {
  EditorHostProps,      // Props for custom editor components
  ExtensionAITool,      // AI tool definition
  AIToolContext,         // Context passed to tool handlers
  ExtensionToolResult,  // Return type for tool handlers
  ExtensionContext,      // Passed to activate()
  PanelHostProps,        // Props for panel components
  ExtensionStorage,      // Workspace and global key-value storage
} from '@nimbalyst/extension-sdk';

import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

// Hook (provided by host at runtime -- do NOT add @nimbalyst/runtime to dependencies)
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
\`\`\``);

  return sections.join('\n\n');
}

/**
 * Generate AGENTS.md for a new extension project.
 */
function generateAgentsMd(options: TemplateOptions & { template: string }): string {
  const { extensionId, template } = options;

  return `# AGENTS.md

This is a Nimbalyst extension project. Read [CLAUDE.md](./CLAUDE.md) before making changes.

## What This Project Is

- Extension ID: \`${extensionId}\`
- Template: \`${template}\`
- Build output is declared by \`manifest.json\`
- Source lives in \`src/\`
- \`dist/\` is generated output and should not be edited by hand

## Documentation

Use these docs in this order:

1. Bundled SDK docs in packaged Nimbalyst:
   - Runtime path: \`path.join(process.resourcesPath, 'extension-sdk-docs')\`
   - macOS example: \`/Applications/Nimbalyst.app/Contents/Resources/extension-sdk-docs\`
   - Windows example: \`<Nimbalyst install dir>\\\\resources\\\\extension-sdk-docs\`
2. Monorepo source docs when available:
   - \`packages/extension-sdk-docs/README.md\`
   - \`packages/extension-sdk-docs/getting-started.md\`
   - \`packages/extension-sdk-docs/custom-editors.md\`
   - \`packages/extension-sdk-docs/ai-tools.md\`
   - \`packages/extension-sdk-docs/manifest-reference.md\`
   - \`packages/extension-sdk-docs/api-reference.md\`
   - \`packages/extension-sdk-docs/examples/\`
3. Hosted docs:
   - \`https://docs.nimbalyst.com/extensions\`

## Required Workflow

- Run \`npm install\` once before the first build
- Build with \`mcp__nimbalyst-extension-dev__extension_build\`
- Install with \`mcp__nimbalyst-extension-dev__extension_install\`
- Iterate with \`mcp__nimbalyst-extension-dev__extension_reload\`
- Check status with \`mcp__nimbalyst-extension-dev__extension_get_status\`
- Use main and renderer log MCP tools for debugging
- Do not restart Nimbalyst unless the user explicitly asks
- When possible, create a representative sample file and use it to verify the extension after install or reload
- After a successful install, tell the user the extension is installed and available across all of their Nimbalyst projects

## Validation Checklist

- \`manifest.json > main\` matches the file Vite emits in \`dist/\`
- Every \`customEditors[].component\` entry matches a key in the exported \`components\` object
- Every tool name listed in \`contributions.aiTools\` has a matching exported handler
- Custom editors use \`host.loadContent()\`, \`host.onSaveRequested()\`, \`host.onFileChanged()\`, and \`host.setDirty()\`
- Styling uses Nimbalyst CSS variables such as \`--nim-bg\`, \`--nim-text\`, and \`--nim-border\`

## When Unsure

- Follow [CLAUDE.md](./CLAUDE.md) as the authoritative project guide
- Prefer SDK docs and local examples over inventing patterns
`;
}

/**
 * Generate a sample Playwright test file for the extension.
 */
function generateTestFile(options: TemplateOptions & { hasEditor: boolean }): string {
  const { extensionId, hasEditor } = options;

  if (hasEditor) {
    return `/**
 * Extension tests -- run via the extension_test_run MCP tool.
 *
 * These tests connect to the running Nimbalyst instance via CDP.
 * Make sure Nimbalyst is running in dev mode (npm run dev).
 *
 * Usage:
 *   extension_test_run({ testFile: "<absolute-path>/tests/basics.spec.ts" })
 */
import { test, expect, extensionEditor } from '@nimbalyst/extension-sdk/testing';

test.describe('${options.name}', () => {
  test('editor renders for the target file', async ({ page }) => {
    const editor = extensionEditor(page, '${extensionId}');
    await expect(editor).toBeVisible({ timeout: 5000 });
  });

  // Add more tests here as you build out the extension
});
`;
  }

  return `/**
 * Extension tests -- run via the extension_test_run MCP tool.
 *
 * These tests connect to the running Nimbalyst instance via CDP.
 * Make sure Nimbalyst is running in dev mode (npm run dev).
 *
 * Usage:
 *   extension_test_run({ testFile: "<absolute-path>/tests/basics.spec.ts" })
 */
import { test, expect } from '@nimbalyst/extension-sdk/testing';

test.describe('${options.name}', () => {
  test('extension is loaded', async ({ page }) => {
    // Verify the extension contributes tools or panels
    // Customize this test based on what your extension provides
    await expect(page.locator('body')).toBeVisible();
  });
});
`;
}

/**
 * Minimal extension template
 * Simple custom editor with basic functionality
 */
export function minimalTemplate(options: TemplateOptions): TemplateFiles {
  const { name, extensionId, filePatterns } = options;
  const componentName = name.replace(/[^a-zA-Z0-9]/g, '') + 'Editor';

  return {
    'CLAUDE.md': generateClaudeMd({ ...options, template: 'minimal' }),
    'AGENTS.md': generateAgentsMd({ ...options, template: 'minimal' }),

    'manifest.json': JSON.stringify(
      {
        id: extensionId,
        name,
        version: '1.0.0',
        description: `Custom editor for ${filePatterns.join(', ')} files`,
        main: 'dist/index.js',
        apiVersion: '1.0.0',
        contributions: {
          customEditors: [
            {
              filePatterns,
              displayName: name,
              component: componentName,
            },
          ],
        },
      },
      null,
      2
    ),

    'package.json': JSON.stringify(
      {
        name: extensionId.replace(/\./g, '-'),
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          build: 'vite build',
        },
        dependencies: {
          react: '^18.2.0',
        },
        devDependencies: {
          '@nimbalyst/extension-sdk': SDK_VERSION,
          '@types/react': '^18.2.0',
          typescript: '^5.0.0',
          vite: '^7.1.12',
        },
      },
      null,
      2
    ),

    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*'],
      },
      null,
      2
    ),

    'vite.config.ts': `import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default defineConfig(createExtensionConfig({
  entry: './src/index.ts',
}));
`,

    'src/index.ts': `import { ${componentName} } from './${componentName}';

export const components = {
  ${componentName},
};

export function activate() {
  console.log('${name} extension activated');
}

export function deactivate() {
  console.log('${name} extension deactivated');
}
`,

    [`src/${componentName}.tsx`]: `import React, { useRef, useReducer } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

export function ${componentName}({ host }: EditorHostProps) {
  const textRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const { isLoading, error, markDirty } = useEditorLifecycle(host, {
    applyContent: (content: string) => {
      textRef.current = content;
      if (textareaRef.current) {
        textareaRef.current.value = content;
      }
      forceRender();
    },
    getCurrentContent: () => textRef.current,
  });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    textRef.current = e.target.value;
    markDirty();
  };

  if (error) {
    return <div style={{ padding: '16px' }}>Error: {error.message}</div>;
  }

  if (isLoading) {
    return <div style={{ padding: '16px' }}>Loading...</div>;
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      padding: '16px',
      boxSizing: 'border-box',
    }}>
      <div style={{
        marginBottom: '12px',
        color: 'var(--nim-text-muted)',
        fontSize: '12px',
      }}>
        Editing: {host.filePath}
      </div>
      <textarea
        ref={textareaRef}
        defaultValue={textRef.current}
        onChange={handleChange}
        placeholder="Start typing..."
        style={{
          flex: 1,
          width: '100%',
          padding: '12px',
          fontSize: '14px',
          fontFamily: 'monospace',
          backgroundColor: 'var(--nim-bg-secondary)',
          color: 'var(--nim-text)',
          border: '1px solid var(--nim-border)',
          borderRadius: '4px',
          resize: 'none',
          outline: 'none',
        }}
      />
    </div>
  );
}
`,

    'tests/basics.spec.ts': generateTestFile({ ...options, hasEditor: true }),
  };
}

/**
 * Custom editor template
 * Full-featured editor with toolbar and AI tools
 */
export function customEditorTemplate(options: TemplateOptions): TemplateFiles {
  const { name, extensionId, filePatterns } = options;
  const componentName = name.replace(/[^a-zA-Z0-9]/g, '') + 'Editor';
  const toolPrefix = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  return {
    'CLAUDE.md': generateClaudeMd({ ...options, template: 'custom-editor' }),
    'AGENTS.md': generateAgentsMd({ ...options, template: 'custom-editor' }),

    'manifest.json': JSON.stringify(
      {
        id: extensionId,
        name,
        version: '1.0.0',
        description: `Custom editor for ${filePatterns.join(', ')} files`,
        main: 'dist/index.js',
        styles: 'dist/index.css',
        apiVersion: '1.0.0',
        permissions: {
          filesystem: true,
          ai: true,
        },
        contributions: {
          customEditors: [
            {
              filePatterns,
              displayName: name,
              component: componentName,
            },
          ],
          aiTools: [`${toolPrefix}.get_info`, `${toolPrefix}.update`],
        },
      },
      null,
      2
    ),

    'package.json': JSON.stringify(
      {
        name: extensionId.replace(/\./g, '-'),
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          build: 'vite build',
        },
        dependencies: {
          react: '^18.2.0',
        },
        devDependencies: {
          '@nimbalyst/extension-sdk': SDK_VERSION,
          '@types/react': '^18.2.0',
          typescript: '^5.0.0',
          vite: '^7.1.12',
        },
      },
      null,
      2
    ),

    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*'],
      },
      null,
      2
    ),

    'vite.config.ts': `import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default defineConfig(createExtensionConfig({
  entry: './src/index.ts',
}));
`,

    'src/index.ts': `import { ${componentName} } from './${componentName}';
import { aiTools } from './aiTools';
import './styles.css';

export const components = {
  ${componentName},
};

export { aiTools };

export function activate() {
  console.log('${name} extension activated');
}

export function deactivate() {
  console.log('${name} extension deactivated');
}
`,

    [`src/${componentName}.tsx`]: `import React, { useRef, useReducer } from 'react';
import { useEditorLifecycle } from '@nimbalyst/extension-sdk';
import type { EditorHostProps } from '@nimbalyst/extension-sdk';

export function ${componentName}({ host }: EditorHostProps) {
  const dataRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const { isLoading, error, markDirty } = useEditorLifecycle(host, {
    applyContent: (content: string) => {
      dataRef.current = content;
      if (textareaRef.current) {
        textareaRef.current.value = content;
      }
      forceRender();
    },
    getCurrentContent: () => dataRef.current,
  });

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    dataRef.current = e.target.value;
    markDirty();
  };

  if (error) {
    return <div className="${toolPrefix}-editor">Error: {error.message}</div>;
  }

  if (isLoading) {
    return <div className="${toolPrefix}-editor">Loading...</div>;
  }

  return (
    <div className="${toolPrefix}-editor">
      <div className="${toolPrefix}-editor-toolbar">
        <span className="${toolPrefix}-editor-title">${name}</span>
        <div className="${toolPrefix}-editor-actions">
          <button onClick={() => console.log('Action 1')}>Action 1</button>
          <button onClick={() => console.log('Action 2')}>Action 2</button>
        </div>
      </div>
      <div className="${toolPrefix}-editor-content">
        <textarea
          ref={textareaRef}
          defaultValue={dataRef.current}
          onChange={handleChange}
          placeholder="Start editing..."
        />
      </div>
    </div>
  );
}
`,

    'src/aiTools.ts': `import type {
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
      error: \`Failed to read active file: \${error instanceof Error ? error.message : String(error)}\`,
    };
  }
}

export const aiTools: ExtensionAITool[] = [
  {
    name: '${toolPrefix}.get_info',
    description: 'Get information about the current file',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, context): Promise<ExtensionToolResult> => {
      const loaded = await loadActiveFile(context);
      if ('success' in loaded) {
        return loaded;
      }

      return {
        success: true,
        message: 'Retrieved file information.',
        data: {
          filePath: loaded.filePath,
          contentLength: loaded.content.length,
          lineCount: loaded.content.split('\\n').length,
        },
      };
    },
  },

  {
    name: '${toolPrefix}.update',
    description: 'Update the file content',
    inputSchema: {
      type: 'object',
      properties: {
        newContent: {
          type: 'string',
          description: 'The new content to set',
        },
      },
      required: ['newContent'],
    },
    handler: async (args, context): Promise<ExtensionToolResult> => {
      if (!context.activeFilePath) {
        return { success: false, error: 'No active file is open.' };
      }

      const newContent = typeof args.newContent === 'string' ? args.newContent : '';
      await context.extensionContext.services.filesystem.writeFile(
        context.activeFilePath,
        newContent
      );

      return {
        success: true,
        message: \`Updated \${context.activeFilePath}.\`,
      };
    },
  },
];
`,

    'src/styles.css': `.${toolPrefix}-editor {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--nim-bg);
  color: var(--nim-text);
}

.${toolPrefix}-editor-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--nim-bg-secondary);
  border-bottom: 1px solid var(--nim-border);
}

.${toolPrefix}-editor-title {
  font-weight: 500;
  font-size: 13px;
}

.${toolPrefix}-editor-actions {
  display: flex;
  gap: 8px;
}

.${toolPrefix}-editor-actions button {
  padding: 4px 12px;
  font-size: 12px;
  background: var(--nim-bg-tertiary);
  border: 1px solid var(--nim-border);
  border-radius: 4px;
  color: var(--nim-text);
  cursor: pointer;
}

.${toolPrefix}-editor-actions button:hover {
  background: var(--nim-bg-hover);
}

.${toolPrefix}-editor-content {
  flex: 1;
  padding: 12px;
  overflow: auto;
}

.${toolPrefix}-editor-content textarea {
  width: 100%;
  height: 100%;
  padding: 12px;
  font-family: monospace;
  font-size: 14px;
  background: var(--nim-bg-secondary);
  color: var(--nim-text);
  border: 1px solid var(--nim-border);
  border-radius: 4px;
  resize: none;
  outline: none;
}
`,

    'tests/basics.spec.ts': generateTestFile({ ...options, hasEditor: true }),
  };
}

/**
 * AI tool template
 * Extension that only provides AI tools (no UI)
 */
export function aiToolTemplate(options: TemplateOptions): TemplateFiles {
  const { name, extensionId } = options;
  const toolPrefix = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  return {
    'CLAUDE.md': generateClaudeMd({ ...options, template: 'ai-tool' }),
    'AGENTS.md': generateAgentsMd({ ...options, template: 'ai-tool' }),

    'manifest.json': JSON.stringify(
      {
        id: extensionId,
        name,
        version: '1.0.0',
        description: `AI tools for ${name.toLowerCase()}`,
        main: 'dist/index.js',
        apiVersion: '1.0.0',
        permissions: {
          ai: true,
        },
        contributions: {
          aiTools: [`${toolPrefix}.analyze`, `${toolPrefix}.transform`],
        },
      },
      null,
      2
    ),

    'package.json': JSON.stringify(
      {
        name: extensionId.replace(/\./g, '-'),
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          build: 'vite build',
        },
        devDependencies: {
          '@nimbalyst/extension-sdk': SDK_VERSION,
          typescript: '^5.0.0',
          vite: '^7.1.12',
        },
      },
      null,
      2
    ),

    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*'],
      },
      null,
      2
    ),

    'vite.config.ts': `import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default defineConfig(createExtensionConfig({
  entry: './src/index.ts',
}));
`,

    'src/index.ts': `import type {
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
      error: \`Failed to read active file: \${error instanceof Error ? error.message : String(error)}\`,
    };
  }
}

// No UI components
export const components = {};

// AI tools
export const aiTools: ExtensionAITool[] = [
  {
    name: '${toolPrefix}.analyze',
    description: 'Analyze the current document',
    scope: 'global',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, context): Promise<ExtensionToolResult> => {
      const loaded = await loadActiveFile(context);
      if ('success' in loaded) {
        return loaded;
      }

      const content = loaded.content;
      const lines = content.split('\\n');
      const words = content.split(/\\s+/).filter(w => w.length > 0);

      return {
        success: true,
        message: 'Analyzed the active document.',
        data: {
          filePath: loaded.filePath,
          stats: {
            characters: content.length,
            lines: lines.length,
            words: words.length,
          },
        },
      };
    },
  },

  {
    name: '${toolPrefix}.transform',
    description: 'Transform the document content',
    scope: 'global',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['uppercase', 'lowercase', 'reverse'],
          description: 'The transformation to apply',
        },
      },
      required: ['operation'],
    },
    handler: async (args, context): Promise<ExtensionToolResult> => {
      const loaded = await loadActiveFile(context);
      if ('success' in loaded) {
        return loaded;
      }

      const operation = args.operation as string;
      let result: string;

      switch (operation) {
        case 'uppercase':
          result = loaded.content.toUpperCase();
          break;
        case 'lowercase':
          result = loaded.content.toLowerCase();
          break;
        case 'reverse':
          result = loaded.content.split('').reverse().join('');
          break;
        default:
          return { success: false, error: \`Unknown operation: \${operation}\` };
      }

      await context.extensionContext.services.filesystem.writeFile(
        loaded.filePath,
        result
      );

      return {
        success: true,
        message: \`Applied \${operation} to \${loaded.filePath}.\`,
      };
    },
  },
];

export function activate() {
  console.log('${name} extension activated');
}

export function deactivate() {
  console.log('${name} extension deactivated');
}
`,

    'tests/basics.spec.ts': generateTestFile({ ...options, hasEditor: false }),
  };
}

/**
 * Starter template
 * Neutral scaffold that Claude can shape into the extension the user describes.
 */
export function starterTemplate(options: TemplateOptions): TemplateFiles {
  const { name, extensionId, filePatterns } = options;

  return {
    'CLAUDE.md': generateClaudeMd({ ...options, template: 'starter' }),
    'AGENTS.md': generateAgentsMd({ ...options, template: 'starter' }),

    'README.md': `# ${name}

This is a neutral Nimbalyst extension starter scaffold.

## What To Do Next

1. Describe the extension you want to Claude in plain language.
2. Ask Claude to update \`manifest.json\`, add the right contributions and permissions, and create any editor, panel, or AI tool code you need.
3. Run \`npm install\` once dependencies are finalized.
4. Ask Claude to build and install the extension in Nimbalyst.

## Current Defaults

- Extension ID: \`${extensionId}\`
- File patterns placeholder: ${filePatterns.map((pattern) => `\`${pattern}\``).join(', ')}
- No custom editors, AI tools, panels, or permissions are declared yet
`,

    'manifest.json': JSON.stringify(
      {
        id: extensionId,
        name,
        version: '1.0.0',
        description: `Starter scaffold for ${name}`,
        main: 'dist/index.js',
        apiVersion: '1.0.0',
        contributions: {},
      },
      null,
      2
    ),

    'package.json': JSON.stringify(
      {
        name: extensionId.replace(/\./g, '-'),
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          build: 'vite build',
        },
        devDependencies: {
          '@nimbalyst/extension-sdk': SDK_VERSION,
          typescript: '^5.0.0',
          vite: '^7.1.12',
        },
      },
      null,
      2
    ),

    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          outDir: 'dist',
          rootDir: 'src',
        },
        include: ['src/**/*'],
      },
      null,
      2
    ),

    'vite.config.ts': `import { defineConfig } from 'vite';
import { createExtensionConfig } from '@nimbalyst/extension-sdk/vite';

export default defineConfig(createExtensionConfig({
  entry: './src/index.ts',
}));
`,

    'src/index.ts': `export const components = {};

export function activate() {
  console.log('${name} extension activated');
}

export function deactivate() {
  console.log('${name} extension deactivated');
}
`,

    'tests/basics.spec.ts': generateTestFile({ ...options, hasEditor: true }),
  };
}

// Export all templates
export const templates = {
  starter: starterTemplate,
  minimal: minimalTemplate,
  'custom-editor': customEditorTemplate,
  'ai-tool': aiToolTemplate,
};
