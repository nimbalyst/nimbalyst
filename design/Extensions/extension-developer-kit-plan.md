---
planStatus:
  planId: plan-extension-developer-kit
  title: Extension Developer Kit Plugin
  status: in-development
  planType: feature
  priority: high
  owner: ghinkle
  stakeholders:
    - extension developers
    - nimbalyst team
  tags:
    - extensions
    - developer-experience
    - meta-tooling
    - custom-editors
    - mcp
  created: "2025-12-13"
  updated: "2025-12-18T01:52:35.013Z"
  progress: 40
---
# Extension Developer Kit (EDK) Plugin


## Vision

A Nimbalyst extension that enables AI-assisted development of Nimbalyst extensions. The EDK creates a complete development environment where Claude can build, test, debug, and iterate on extensions in real-time - all within the running Nimbalyst application.

The key insight: **extensions can create new ways to visualize and interact with any type of data**. The EDK makes it dramatically easier to build these custom editors, unlocking a universe of specialized tools:

- Data model editors (DatamodelLM - already built)
- Mockup and wireframe designers
- CSV/tabular data viewers with pivot tables
- 3D object modelers
- Presentation builders
- Music notation editors
- Knowledge graph visualizers
- Database query builders
- Report designers
- Custom MCP tool interfaces
- Circuit diagram editors
- Flowchart and diagram tools
- And anything else a developer can imagine

## Goals

1. **Live Development Loop** - Build extensions inside Nimbalyst while they run in Nimbalyst
2. **AI-First Workflow** - Claude has direct access to build, test, and debug tools
3. **Documentation Access** - Extension API docs are always available to the agent
4. **Safe Sandboxing** - Protect the host Nimbalyst from extension crashes
5. **Rapid Iteration** - Hot reload, instant feedback, error recovery

## Architecture Overview

The EDK is intentionally minimal. Extension development is just a normal Nimbalyst project - Claude reads/writes files with standard tools. The EDK only provides what Claude can't do otherwise: process integration for build, install, and hot reload.

```
+------------------------------------------+
|         Nimbalyst Windows                |
|                                          |
|  +----------------+  +----------------+  |
|  | Main Project   |  | Extension Dev  |  |
|  | (using ext)    |  | Project        |  |
|  +----------------+  +----------------+  |
|                                          |
|  +----------------+                      |
|  | SDK Docs       |  <- Read-only        |
|  | (reference)    |     built-in project |
|  +----------------+                      |
+------------------------------------------+
         |
         v
+------------------------------------------+
|   MCP Tools (minimal set)                |
|  - extension:build     Build the ext     |
|  - extension:install   Install to host   |
|  - extension:reload    Hot reload        |
|  - extension:uninstall Remove from host  |
+------------------------------------------+
```

**What's NOT an MCP tool (uses existing capabilities):**
- File read/write - Claude's standard Edit/Write tools
- Creating projects - Menu item + template copy
- Reading docs - Open the SDK docs project
- Viewing output - Build tool returns stdout/stderr

## Core Components

### 1. Extension Sandbox Runtime

A protected environment for running extensions under development:

**Isolation Features:**
- Separate extension loader instance
- Error boundaries around all extension code
- Automatic crash recovery
- Memory and CPU limits
- Timeout protection for runaway code

**Hot Reload:**
- Watch file changes in extension source
- Rebuild on save
- Reload without restarting Nimbalyst
- Preserve state across reloads where possible

**Error Handling:**
- Catch all extension errors
- Format stack traces with source maps
- Feed errors back to Claude with context
- Suggest fixes based on common patterns

### 2. MCP Tools for Claude

A minimal set of tools for process integration - things Claude can't do with standard file operations:

```
extension:build
  - path: string (extension project root)
  Runs `npm run build` (vite build)
  Returns: { success: boolean, stdout: string, stderr: string }

extension:install
  - path: string (extension project root)
  Installs the built extension into the running Nimbalyst instance
  Returns: { success: boolean, extensionId: string }

extension:reload
  - extensionId: string
  Rebuilds and hot-reloads the extension
  Returns: { success: boolean, stdout: string, stderr: string }

extension:uninstall
  - extensionId: string
  Removes the extension from the running instance
  Returns: { success: boolean }
```

**That's it.** Everything else uses existing capabilities:

| Task | How |
| --- | --- |
| File read/write | Claude's standard Edit/Write/Read tools |
| Create project | "File > New Extension Project" menu item |
| Read documentation | Open SDK docs project as workspace |
| Run tests | Bash tool: `npm test` |
| Screenshots | Existing screenshot MCP tools |
| View logs | Console / DevTools |

### 3. Extension Project Templates

Pre-built templates to accelerate development:

#### Minimal Template
- Basic manifest.json
- Empty activate/deactivate
- TypeScript config
- Build setup

#### Custom Editor Template
- Full custom editor scaffold
- React component structure
- Theme integration
- Save/load handlers
- State management pattern

#### AI Tool Template
- Tool definition boilerplate
- Handler implementation
- Context access patterns
- Result formatting

#### Slash Command Template
- Command registration
- Picker menu integration
- Lexical node (if inserting content)

### 4. Development Workflow

Extension development uses standard Nimbalyst project capabilities:

**Three-Window Pattern:**
1. **Main Project** - Where you're using the extension (e.g., editing CSVs)
2. **Extension Project** - The extension source code you're developing
3. **SDK Docs** - Read-only reference project (shipped with Nimbalyst)

**The workflow:**
- Open extension project as a normal Nimbalyst workspace
- Claude edits files with standard Edit/Write tools
- Claude uses `extension:build` and `extension:install` MCP tools
- User tests in their main project window
- Iterate until done

### 5. Creating New Extensions

**Menu item: "File > New Extension Project..."**

Dialog flow:
1. Choose template (Custom Editor, AI Tool, Minimal)
2. Pick location for the new project
3. Enter extension name
4. Nimbalyst creates project from template
5. Opens the new project in a new window

No MCP tool needed - this is a one-time setup action.

## Custom Editor Development Flow

The primary use case - building new custom editors:

### Step 1: Create Project
```
User clicks: File > New Extension Project...
Selects: "Custom Editor" template
Location: ~/projects/csv-editor
Name: "CSV Editor"

Nimbalyst creates the project and opens it
```

### Step 2: Define the Data Model
```
Claude edits types.ts to define:
- CSVFile interface
- Row and Cell types
- Selection state
- Edit operations
```

### Step 3: Build the React Component
```
Claude creates the editor component:
- Table rendering with virtualization
- Cell selection and editing
- Column resizing
- Sort and filter controls
- Theme integration
```

### Step 4: Implement File I/O
```
Claude implements:
- CSV parsing on load
- CSV serialization on save
- Dirty state tracking
- Undo/redo support
```

### Step 5: Add AI Tools (Optional)
```
Claude adds tools for AI interaction:
- csv:get_schema - Returns column names and types
- csv:query - Runs queries on the data
- csv:transform - Applies transformations
```

### Step 6: Test and Iterate
```
[Claude uses extension:build]
Build successful

[Claude uses extension:install]
Installed as "com.developer.csv-editor"

User: Opens a test .csv file in their main project window
User: "It looks good but the header row should be sticky"

[Claude edits CSVEditor.tsx]
[Claude uses extension:reload]
```

### Step 7: Write Tests
```
Claude creates Playwright tests:
- Load file correctly
- Edit cells
- Save changes
- Handle edge cases
```

## Safety and Sandboxing

### Error Containment

1. **Build Errors** - Captured and returned to Claude with context
2. **Runtime Errors** - Caught by error boundaries, logged, extension disabled
3. **Infinite Loops** - Timeout protection, automatic termination
4. **Memory Leaks** - Monitor heap size, warn and reload if needed

### Host Protection

1. **Separate Extension Loader** - Dev extensions don't mix with production
2. **File System Isolation** - Can only access extension project files
3. **No Main Process Access** - Extensions run in renderer only
4. **Crash Recovery** - Sandbox can be reset without affecting host

### Feedback Loop

When errors occur:
1. Capture full error with stack trace
2. Apply source maps for readable locations
3. Include surrounding code context
4. Suggest common fixes
5. Return to Claude for correction

## Documentation Integration

Documentation is a built-in read-only project that ships with Nimbalyst:

**SDK Docs Project Contents:**
```
extension-sdk-docs/
  getting-started.md
  custom-editors.md
  ai-tools.md
  api-reference.md
  examples/
    minimal/
    custom-editor/
    ai-tool/
```

**How it works:**
- User opens SDK docs project in a reference window
- Claude reads files with standard Read tool
- Type definitions in SDK include JSDoc for IDE autocomplete
- Examples are working code that can be copied

## Development Workflow Example

```
User: "Build me a Mermaid diagram editor"

User: File > New Extension Project...
      Template: Custom Editor
      Location: ~/extensions/mermaid-editor
      [Opens in new window]

Claude: I'll build the Mermaid editor. Let me check the SDK docs.

[Claude reads custom-editors.md from SDK docs window]

[Claude edits src/types.ts with Edit tool]
Defining MermaidDocument interface...

[Claude edits src/MermaidEditor.tsx with Edit tool]
Creating editor with split-pane: code left, preview right

[Claude uses extension:build]
Build successful

[Claude uses extension:install]
Installed as "com.developer.mermaid-editor"

User: Opens test.mmd in main project window
User: "Looks good! Can you add zoom controls?"

[Claude edits MermaidEditor.tsx]
[Claude uses extension:reload]

User: "Perfect. Now add AI tools so you can help me edit diagrams"

[Claude edits src/aiTools.ts]
[Claude uses extension:build]
[Claude uses extension:reload]

Done! The extension is installed. Open any .mmd file to use it.
```

## Extension Templates Deep Dive

### Custom Editor Template Structure

```
my-extension/
  manifest.json           # Extension metadata
  package.json            # Dependencies
  tsconfig.json           # TypeScript config
  vite.config.ts          # Build config
  src/
    index.tsx             # Extension entry point
    types.ts              # Data type definitions
    components/
      MyEditor.tsx        # Main editor component
      Toolbar.tsx         # Editor toolbar
    styles.css            # Scoped styles
    aiTools.ts            # AI tool definitions (optional)
    store.ts              # State management (optional)
  tests/
    editor.spec.ts        # Playwright tests
```

### Manifest Template

```json
{
  "id": "com.developer.my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "description": "Description here",
  "main": "dist/index.js",
  "styles": "dist/styles.css",
  "apiVersion": "1.0.0",
  "permissions": {
    "filesystem": true,
    "ai": true
  },
  "contributions": {
    "customEditors": [{
      "filePatterns": ["*.myext"],
      "displayName": "My Editor",
      "component": "MyEditor"
    }],
    "aiTools": ["myext.tool_name"],
    "newFileMenu": [{
      "extension": ".myext",
      "displayName": "My File Type",
      "icon": "description",
      "defaultContent": "{}"
    }]
  }
}
```

## Potential Custom Editors to Build

Examples of what developers could create with the EDK:

| Editor Type | File Extension | Description |
| --- | --- | --- |
| CSV Viewer | .csv | Spreadsheet-like editing with sorting/filtering |
| Mermaid | .mmd | Diagram code + live preview |
| PlantUML | .puml | UML diagrams with rendering |
| Excalidraw | .excalidraw | Whiteboard-style drawings |
| Music Score | .musicxml | Musical notation editor |
| Slide Deck | .slides | Presentation builder |
| 3D Model | .gltf | Basic 3D viewer/editor |
| Graph | .graph | Knowledge graph visualization |
| Form Builder | .form | Drag-and-drop form designer |
| API Tester | .http | REST API testing interface |
| SQL Query | .sql | Query builder with results |
| State Machine | .fsm | State machine designer |
| Timeline | .timeline | Project timeline editor |
| Kanban | .kanban | Task board editor |
| Mind Map | .mindmap | Hierarchical mind mapping |

## Implementation Phases

### Phase 1: SDK Package (DONE)
- `@nimbalyst/extension-sdk` npm package
- `createExtensionConfig()` vite helper
- `REQUIRED_EXTERNALS` constant
- TypeScript types for extensions
- `validateExtensionBundle()` utility

### Phase 2: MCP Tools (DONE)
- `extension:build` - Run vite build, return output
- `extension:install` - Install to running Nimbalyst (creates symlink + hot-loads)
- `extension:reload` - Hot reload (build + reinstall to all windows)
- `extension:uninstall` - Remove from running instance (unloads + removes symlink)

**Opt-in setting:**
- User must enable "Extension Dev Tools" in Settings > Advanced to activate the MCP tools
- Setting stored in app settings store (`extensionDevToolsEnabled`)
- Toggle in Advanced Settings panel starts/stops the MCP server immediately

**Implementation details:**
- MCP server at `packages/electron/src/main/mcp/extensionDevServer.ts`
- ExtensionDevService at `packages/electron/src/main/services/ExtensionDevService.ts`
- IPC handlers in `packages/electron/src/main/ipc/ExtensionHandlers.ts` and `SettingsHandlers.ts`
- Renderer-side listeners in `packages/electron/src/renderer/plugins/registerExtensionSystem.ts`
- ExtensionLoader additions: `loadExtensionFromPath()`, `reloadExtension()`
- UI toggle in `packages/electron/src/renderer/components/GlobalSettings/panels/AdvancedPanel.tsx`

### Phase 3: New Extension Project Flow
- "File > New Extension Project..." menu item
- Template selection dialog
- Location picker
- Project creation from templates
- Auto-open in new window

### Phase 4: Project Templates
- Minimal template (manifest + entry point)
- Custom editor template (full scaffold)
- AI tool template

### Phase 5: SDK Documentation Project
- Ship docs as read-only Nimbalyst project
- getting-started.md
- custom-editors.md
- ai-tools.md
- api-reference.md
- Working example code

### Phase 6: Publishing (Future)
- Extension packaging
- Version management
- Distribution to extension registry

## Success Metrics

1. **Time to First Extension** - Under 30 minutes for a simple custom editor
2. **Iteration Speed** - Build + reload under 2 seconds
3. **Error Recovery** - 100% of extension crashes contained
4. **Documentation Coverage** - All APIs searchable and documented
5. **Test Coverage** - All templates include working test examples

## Dependencies

- `@nimbalyst/extension-sdk` package (Phase 1 - DONE)
- Extension system core (already built)
- Claude Agent SDK / MCP integration
- Nimbalyst internal MCP server infrastructure

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Build errors confusing | Return full stdout/stderr from MCP tools |
| Hot reload breaks state | Document limitations, suggest full reload |
| Complex debugging | Source maps, error boundaries with context |
| Documentation drift | Generate types from source, automated checks |

## Open Questions

1. How do we handle extensions that need main process access?
2. What's the distribution model for community extensions?
3. How do we version the extension API for backwards compatibility?
4. Should dev extensions install globally or per-project?

## Next Steps

1. Implement the 4 MCP tools (build, install, reload, uninstall)
2. Create "New Extension Project" menu item and dialog
3. Build project templates
4. Write SDK documentation as a Nimbalyst project
5. Test end-to-end by building a new extension with the EDK
