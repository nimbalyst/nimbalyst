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

> The permission system is **evolving**. The legacy
> `permissions: { filesystem, ai, network }` object governs renderer-side
> capabilities and is gradually being folded into a granular id catalog that
> also drives [backend modules](#backendmodules). Expect the manifest shape
> for permissions to change in upcoming versions.

### Renderer-side capabilities

Declare what your renderer-side code (React components, slash command
handlers, AI tool handlers) needs:

```json
"permissions": {
  "filesystem": true,
  "ai": true,
  "network": false
}
```

| Permission | Description |
| --- | --- |
| `filesystem` | Read and write files through extension services |
| `ai` | Register AI tools, context providers, and call AI chat/completion models directly (`listModels`, `chatCompletion`, `chatCompletionStream`) |
| `network` | Reserved for network-enabled extensions |

### Granular permissions for brokered host services

A second `permissions.catalog` array declares host-brokered capabilities used
by both renderer-side code (e.g., `host.data.query()`) and backend modules
(when they call back into the host). Catalog ids:

- `workspace-files`
- `nimbalyst-database-read`
- `nimbalyst-database-write`
- `secrets-read`
- `mcp-server-register`

Backend modules declare their additional brokered permissions on the module
contribution itself (`contributions.backendModules[].permissions`). See
[permissions.md](./permissions.md) for the full catalog, the backend-module
allowlist, and the consent flow.

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

Add a compact settings UI under Settings → Extensions → Installed.

```json
"settingsPanel": {
  "component": "CsvSettingsPanel",
  "title": "CSV Tools",
  "icon": "settings",
  "order": 100
}
```

### `settingsRoutes`

Add one or more first-class rows to the Settings sidebar. Route components are resolved from the module's `settingsPanel` export namespace.

```json
"settingsRoutes": [
  {
    "id": "memory",
    "scope": "project",
    "label": "Memory",
    "group": "Extensions",
    "icon": "psychology",
    "order": 50,
    "component": "MemorySettingsRoute"
  }
]
```

`id`, `scope`, `label`, and `component` are required. `scope` must be `"application"` or `"project"`; account routes are not supported. `group`, `icon`, and `order` default to `"Extensions"`, `"extension"`, and `100`. Project-scoped components receive `workspacePath` and `projectTarget` in addition to the standard settings panel props.

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

### `backendModules`

Declare isolated runtimes for code that needs to spawn processes, hit the
network, or otherwise reach beyond what the renderer can do. Each module is
loaded into a `utility-process` or `worker-thread` and stays inert until the
user grants it.

Granting a backend module is itself the consent to run native code locally;
the consent prompt says so explicitly. The `permissions` array on the module
declares **additional** host-brokered capabilities (database, secrets, etc.)
beyond ambient Node access. It may be empty.

Any extension can ship a backend module -- there is no provenance allowlist.
The user's first-use consent prompt is the gate; built-in extensions ship
inside the app bundle and are auto-granted. Malformed declarations are still
dropped by shape validation. See [permissions.md](./permissions.md) for the
full policy.

```json
"backendModules": [
  {
    "id": "jupyter-runtime",
    "entry": "dist/backend/jupyter.js",
    "runtime": "utility-process",
    "permissions": [
      "workspace-files"
    ],
    "enablement": {
      "default": "disabled",
      "promptOn": "firstUse",
      "purpose": "Run Jupyter kernels and execute notebook cells locally."
    }
  }
]
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique within the extension. Lowercase, `[a-z0-9._-]`, max 64 chars |
| `entry` | `string` | Relative path to a compiled JS file. No `/` or `..` segments |
| `runtime` | `"utility-process"` \| `"worker-thread"` | OS-isolated process vs. in-process worker thread |
| `permissions` | `string[]` | Granular permission ids from the [permission catalog](./permissions.md#granular-permission-catalog). Non-empty |
| `enablement.default` | `"disabled"` | Required value -- privileged code is always opt-in |
| `enablement.promptOn` | `"firstUse"` | Defer the consent prompt until the user invokes the capability |
| `enablement.purpose` | `string` | Shown verbatim in the consent prompt. Max 280 chars |

An extension may declare at most **8** backend modules.

See [permissions.md](./permissions.md) for the full permission catalog, the
consent flow, runtime choice guidance, and build-time validation rules.

### `nodes`, `transformers`, `lexicalExtensions`, and `hostComponents`

These contribution arrays declare names of exports provided by your module.

```json
"nodes": ["MyLexicalNode"],
"transformers": ["myMarkdownTransformer"],
"lexicalExtensions": ["MyLexicalExtension"],
"hostComponents": ["MyFloatingToolbar"]
```

Use these with matching module exports:

- `nodes` -> `export const nodes = { ... }`
- `transformers` -> `export const transformers = { ... }`
- `lexicalExtensions` -> `export const lexicalExtensions = { ... }`
- `hostComponents` -> `export const hostComponents = { ... }`

This is the preferred way to contribute to the built-in markdown editor
and transcript renderer. The host reads these exports and wires them into
the runtime registries automatically.

See [contribution-points.md](./contribution-points.md) for examples of
when to use the declarative manifest path versus the imperative runtime
APIs.

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
