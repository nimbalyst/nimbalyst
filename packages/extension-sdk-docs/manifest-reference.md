# Manifest Reference

The `manifest.json` file declares your extension metadata, permissions, and contributions.

## Basic Structure

```json
{
  "id": "com.example.my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "main": "dist/index.js",
  "styles": "dist/index.css",
  "apiVersion": "1.0.0",
  "permissions": {},
  "contributions": {}
}
```

## Required Fields

### `id`

Unique identifier for your extension.

```json
"id": "com.yourcompany.extension-name"
```

- Use reverse-domain style identifiers.
- Must start with a letter.
- Can contain letters, numbers, dots, underscores, and hyphens.

### `name`

Human-readable name shown in the UI.

```json
"name": "CSV Spreadsheet Editor"
```

### `version`

Extension version in semver format.

```json
"version": "1.0.0"
```

### `main`

Path to the built JavaScript entry point, relative to the manifest.

```json
"main": "dist/index.js"
```

`main` is required for normal extensions. Claude-plugin-only extensions can omit it if they do not ship runtime code.

## Optional Top-Level Fields

### `description`

Short description of what your extension does.

```json
"description": "Edit CSV files with a spreadsheet interface"
```

### `author`

Author or organization name.

```json
"author": "Nimbalyst"
```

### `styles`

Path to a CSS bundle to load with your extension.

```json
"styles": "dist/index.css"
```

### `apiVersion`

Optional extension API version string.

```json
"apiVersion": "1.0.0"
```

This is currently recommended, not required. Use it so future compatibility checks can warn more precisely.

### `requiredReleaseChannel`

Restrict visibility to a release channel.

```json
"requiredReleaseChannel": "alpha"
```

Allowed values:
- `"stable"`
- `"alpha"`

### `defaultEnabled`

Control whether the extension starts enabled the first time it is discovered.

```json
"defaultEnabled": false
```

If omitted, the extension defaults to enabled.

## Permissions

Declare the capabilities your extension needs:

```json
"permissions": {
  "filesystem": true,
  "ai": true,
  "network": false
}
```

Available permissions:

| Permission | Description |
| --- | --- |
| `filesystem` | Read and write files through extension services |
| `ai` | Register AI tools, context providers, and call AI chat/completion models directly (`listModels`, `chatCompletion`, `chatCompletionStream`) |
| `network` | Reserved for network-enabled extensions |

## Contributions

The `contributions` object declares what your extension adds to Nimbalyst.

### `customEditors`

Register custom editors for matching file types.

```json
"contributions": {
  "customEditors": [
    {
      "filePatterns": ["*.csv", "*.tsv"],
      "displayName": "Spreadsheet Editor",
      "component": "SpreadsheetEditor",
      "supportsSourceMode": true,
      "supportsDiffMode": true,
      "showDocumentHeader": true
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `filePatterns` | `string[]` | Glob patterns for matching files |
| `displayName` | `string` | Name shown in the editor selector |
| `component` | `string` | Key in your exported `components` object |
| `supportsSourceMode` | `boolean` | Enables the host's source-mode toggle |
| `supportsDiffMode` | `boolean` | Enables the host's AI diff review mode (approve/reject bar). Defaults to `false` - must be explicitly set to `true` to enable. |
| `showDocumentHeader` | `boolean` | Shows the host-provided document header above the editor. Defaults to `true` when omitted |

### `documentHeaders`

Render UI above matching editors without replacing the editor itself.

```json
"documentHeaders": [
  {
    "id": "astro-frontmatter",
    "filePatterns": ["*.astro"],
    "displayName": "Astro Frontmatter",
    "component": "AstroFrontmatterHeader",
    "priority": 100
  }
]
```

### `aiTools`

Declare AI tools your extension provides. This is an array of tool name strings, not full tool definitions.

```json
"aiTools": [
  "csv.get_schema",
  "csv.query"
]
```

The actual tool definitions belong in your TypeScript exports:

```ts
export const aiTools: ExtensionAITool[] = [
  {
    name: 'csv.get_schema',
    description: 'Get the column names from the active CSV file',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      return { success: true, data: {} };
    },
  },
];
```

### `newFileMenu`

Add items to the "New File" menu.

```json
"newFileMenu": [
  {
    "extension": ".csv",
    "displayName": "CSV Spreadsheet",
    "icon": "table",
    "defaultContent": "Column A,Column B\n,\n,"
  }
]
```

### `fileIcons`

Override file icons in the sidebar.

```json
"fileIcons": {
  "*.csv": "table",
  "*.tsv": "table",
  "*.json": "data_object"
}
```

Keys are glob patterns. Values are Material icon names.

### `slashCommands`

Register slash commands for the command picker.

```json
"slashCommands": [
  {
    "id": "csv.insert-table",
    "title": "Insert CSV Table",
    "description": "Insert a table from CSV data",
    "icon": "table",
    "keywords": ["csv", "table"],
    "handler": "insertCsvTable"
  }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Stable command identifier |
| `title` | `string` | Label shown in the picker |
| `description` | `string` | Optional help text |
| `icon` | `string` | Optional Material icon name |
| `keywords` | `string[]` | Optional search keywords |
| `handler` | `string` | Name of the exported handler function |

### `commands`

Reserved for future command contributions.

```json
"commands": [
  {
    "id": "csv.refresh",
    "title": "Refresh CSV Data",
    "keybinding": "CmdOrCtrl+Shift+R"
  }
]
```

### `configuration`

Declare user/workspace settings for your extension.

```json
"configuration": {
  "title": "CSV Tools",
  "properties": {
    "delimiter": {
      "type": "string",
      "default": ",",
      "description": "Default delimiter for new CSV files",
      "scope": "workspace"
    }
  }
}
```

### `claudePlugin`

Bundle a Claude Code plugin with the extension.

```json
"claudePlugin": {
  "path": "claude-plugin",
  "displayName": "CSV Assistant",
  "description": "Adds Claude Code helpers for CSV workflows",
  "enabledByDefault": true
}
```

### `agentWorkflows`

Bundle provider-neutral agent workflows that Nimbalyst can export to supported
agent providers such as Claude Code and Codex.

```json
"agentWorkflows": {
  "path": "agent-workflows",
  "displayName": "CSV Agent Workflows",
  "description": "Reusable coding workflows for CSV tasks",
  "enabledByDefault": true
}
```

The directory at `path` should contain `commands/` and/or `skills/`
subdirectories using the familiar markdown formats:

```text
agent-workflows/
  commands/
    review.md
  skills/
    triage/
      SKILL.md
```

### `panels`

Register non-file-based panels.

```json
"panels": [
  {
    "id": "database-browser",
    "title": "Database",
    "icon": "database",
    "placement": "sidebar",
    "aiSupported": true
  }
]
```

`placement` must be one of:
- `"sidebar"`
- `"fullscreen"`
- `"floating"`

### `settingsPanel`

Add a settings UI for your extension inside the main Settings screen.

```json
"settingsPanel": {
  "component": "CsvSettingsPanel",
  "title": "CSV Tools",
  "icon": "settings",
  "order": 100
}
```

### `themes`

Register selectable themes contributed by your extension.

```json
"themes": [
  {
    "id": "solarized-light",
    "name": "Solarized Light",
    "isDark": false,
    "colors": {
      "bg": "#fdf6e3",
      "text": "#657b83",
      "primary": "#268bd2"
    }
  }
]
```

### `nodes`, `transformers`, and `hostComponents`

These contribution arrays declare names of exports provided by your module.

```json
"nodes": ["MyLexicalNode"],
"transformers": ["myMarkdownTransformer"],
"hostComponents": ["MyFloatingToolbar"]
```

## Complete Example

```json
{
  "id": "com.nimbalyst.csv-tools",
  "name": "CSV Tools",
  "version": "1.0.0",
  "description": "Custom CSV editing and AI helpers",
  "author": "Nimbalyst",
  "main": "dist/index.js",
  "styles": "dist/index.css",
  "apiVersion": "1.0.0",
  "defaultEnabled": true,
  "permissions": {
    "filesystem": true,
    "ai": true
  },
  "contributions": {
    "customEditors": [
      {
        "filePatterns": ["*.csv", "*.tsv"],
        "displayName": "Spreadsheet Editor",
        "component": "SpreadsheetEditor",
        "supportsSourceMode": true
      }
    ],
    "aiTools": [
      "csv.get_schema",
      "csv.query"
    ],
    "fileIcons": {
      "*.csv": "table",
      "*.tsv": "table"
    },
    "slashCommands": [
      {
        "id": "csv.insert-table",
        "title": "Insert CSV Table",
        "handler": "insertCsvTable"
      }
    ],
    "configuration": {
      "properties": {
        "delimiter": {
          "type": "string",
          "default": ","
        }
      }
    }
  }
}
```

## File Pattern Syntax

File patterns use glob syntax:

| Pattern | Matches |
| --- | --- |
| `*.csv` | Any file ending in `.csv` |
| `*.{csv,tsv}` | Files ending in `.csv` or `.tsv` |
| `data/*.json` | JSON files in `data/` |
| `**/*.test.ts` | Test files anywhere in the tree |

## Validation Notes

Nimbalyst validates your manifest on load. Common errors:

- Missing required top-level fields: `id`, `name`, `version`, or `main`
- `aiTools` contains objects instead of tool-name strings
- `slashCommands` uses old `name` / `displayName` fields instead of `id` / `title`
- `fileIcons` is declared as an array instead of an object map
- Contribution component names do not match your exported module names

## Best Practices

1. Use a stable reverse-domain `id`.
2. Request only the permissions you actually need.
3. Keep `contributions.aiTools` and your exported `aiTools` array in sync.
4. Prefer adding `apiVersion` even though it is currently optional.
5. Validate on every build with `validateExtensionBundle()`.
