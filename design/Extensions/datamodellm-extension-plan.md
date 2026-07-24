---
planStatus:
  planId: plan-datamodellm-extension
  title: DatamodelLM Extension - First Plugin Implementation
  status: in-development
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders:
    - ghinkle
  tags:
    - extensions
    - datamodellm
    - custom-editor
    - ai-tools
    - api-design
  created: "2025-12-11"
  updated: "2025-12-12T00:00:00.000Z"
  progress: 75
  startDate: "2025-12-11"
---
# DatamodelLM Extension - First Plugin Implementation

## Current Status

DatamodelLM is the first working extension for Nimbalyst. The extension system infrastructure is complete and the extension loads successfully from `packages/extensions/datamodellm/`.

**Key accomplishments:**
- Extension system fully functional (discovery, loading, lifecycle)
- Custom editor renders .prisma files with visual ERD canvas
- AI tools (get_schema, capture_screenshot) integrated with Claude Code via MCP
- Theme integration working across light/dark/crystal-dark
- New File menu contribution for creating data models

## Implementation Progress

### Phase 0: Extension System Infrastructure - COMPLETE
- [x] Define extension manifest schema (JSON schema + TypeScript types)
- [x] Create ExtensionPlatformService interface in runtime package
- [x] Build ExtensionLoader (discover, load, unload extensions)
- [x] Create ExtensionContext for extensions to use
- [x] Implement ElectronExtensionPlatformService
- [x] Integrate ExtensionLoader with CustomEditorRegistry
- [x] Test with minimal "hello world" extension
- [x] Fix symlink handling in extension discovery
- [x] Fix ES module import transformation (handle `import X as Y` syntax)
- [x] Fix identifier regex to handle `$` in minified variable names
- [x] Add jsx-dev-runtime to externals and host dependencies
- [x] Create E2E test for extension loading
- [x] Isolate test extensions directory for Playwright tests
- [ ] Add extension management UI in settings (deferred)

### Phase 1: DatamodelLM Extension Package - COMPLETE
- [x] Create separate datamodellm-extension project structure
- [x] Port DataModelCanvas and related components
- [x] Port EntityNode and RelationshipEdge components
- [x] Adapt Zustand store for file-based model
- [x] Create DatamodelLMEditor implementing CustomEditorProps
- [x] Configure Vite/bundler with externals
- [x] Build extension manifest.json
- [x] Theme integration via CSS variables
- [x] Install via symlink and test loading
- [x] Add toolbar with view mode selector, add entity button, and stats

### Phase 2: AI Tool Integration - COMPLETE
- [x] Create ExtensionAIToolsBridge for MCP integration
- [x] Implement get_schema tool (read-only schema access)
- [x] Implement capture_screenshot tool
- [x] Tools integrated with Claude Code via MCP
- [x] Tool scoping (editor-scoped vs global)
- Note: Schema manipulation is handled by Claude editing the .prisma file directly

### Phase 3: Context Layering - NOT STARTED
- [ ] Implement context provider for workspace data models
- [ ] Add active document context (current schema in AI context)
- [ ] Add DatamodelLM-specific instructions injection
- [ ] Test AI awareness of existing data models

### Phase 4: Advanced Features - PARTIAL
- [x] Custom toolbar for data model files
- [x] New File menu contribution for .prisma files
- [ ] File tree integration (custom icon from manifest - partially working)
- [ ] Export to document (insert SQL/JSON Schema as code block)
- [ ] History integration with Nimbalyst's document history

## Executive Summary

Implement DatamodelLM as the first **dynamically loadable extension** for Nimbalyst. This means building the extension loading infrastructure alongside the plugin itself - the extension should live outside the core app and be loaded at runtime.

**Strategy**: Build both the extension system infrastructure AND DatamodelLM as an external extension simultaneously. This ensures we're not just adding another hardcoded feature, but actually validating a real plugin architecture.

## Goals

1. **Build extension loader infrastructure in runtime package** - Platform-agnostic, works on Electron and Capacitor
2. **Create DatamodelLM as an external extension** - Not compiled into any platform package
3. **Define extension manifest format** - How extensions declare capabilities
4. **Validate the extension API** through real implementation
5. **Enable install/uninstall workflow** - Extensions can be added without rebuilding app
6. **Platform abstraction** - Extensions use platform services, not platform APIs directly

## DatamodelLM Overview

DatamodelLM is an AI-assisted data modeling tool with:

- **React Flow canvas** for visual entity-relationship diagrams
- **Zustand state management** for entities, relationships, projects, and history
- **AI chat integration** with 6 tools for schema manipulation
- **Time-travel history** via snapshots
- **Multiple export formats** (SQL DDL, JSON Schema, DBML, Mongoose)
- **Multiple view modes** (full, standard, minimal, compact)

### Key DatamodelLM Components to Reuse

| Component | Location | Description |
| --- | --- | --- |
| DataModelCanvas | `src/editor/DataModelCanvas.tsx` | React Flow canvas with custom nodes/edges |
| EntityNode | `src/editor/EntityNode.tsx` | Custom node displaying entity fields |
| RelationshipEdge | `src/editor/RelationshipEdge.tsx` | Custom edge with cardinality markers |
| Store | `src/editor/store.ts` | Zustand store for all state |
| Types | `src/editor/types.ts` | TypeScript types for entities, relationships, etc. |
| AI Service | `src/editor/ai-service.ts` | Tool definitions and AI streaming |
| Export utilities | Various | SQL, JSON Schema, DBML, Mongoose generation |

## Implementation Plan

### Phase 0: Extension System Infrastructure

**Goal**: Build the infrastructure to load extensions from outside the core app.

#### Extension Location & Discovery

Extensions will be loaded from:
1. **User extensions directory**: `~/Library/Application Support/@nimbalyst/extensions/`
2. **Workspace extensions**: `.nimbalyst/extensions/` within a project (future)

#### Extension Package Structure

```
datamodellm-extension/
├── package.json          # npm package with nimbalyst-extension metadata
├── manifest.json         # Extension manifest (capabilities, permissions)
├── dist/
│   ├── index.js          # Bundled extension entry point
│   ├── index.css         # Bundled styles
│   └── assets/           # Icons, images
└── src/                  # Source (not shipped, for development)
```

**NOT** in the monorepo's packages/. Instead:
#### Extension Manifest Format

```json
{
  "id": "com.nimbalyst.datamodellm",
  "name": "DatamodelLM",
  "version": "1.0.0",
  "description": "AI-assisted data modeling",
  "author": "Nimbalyst",
  "main": "dist/index.js",
  "styles": "dist/index.css",

  "permissions": {
    "filesystem": true,
    "ai": true
  },

  "contributions": {
    "customEditors": [
      {
        "filePatterns": ["*.datamodel"],
        "displayName": "Data Model Editor",
        "component": "DatamodelLMEditor"
      }
    ],
    "aiTools": [
      "create_entity",
      "update_entity",
      "delete_entity",
      "create_relationship",
      "update_relationship",
      "delete_relationship"
    ],
    "fileIcons": {
      "*.datamodel": "database"
    }
  }
}
```

#### Extension Loader Architecture

The extension system lives in `packages/runtime/` to be platform-agnostic. Platform-specific concerns (file paths, module loading) are abstracted behind services.

```typescript
// packages/runtime/src/extensions/ExtensionLoader.ts
class ExtensionLoader {
  private loadedExtensions = new Map<string, LoadedExtension>();
  private platformService: ExtensionPlatformService;

  constructor(platformService: ExtensionPlatformService) {
    this.platformService = platformService;
  }

  async discoverExtensions(): Promise<ExtensionManifest[]>;
  async loadExtension(manifest: ExtensionManifest): Promise<LoadedExtension>;
  async unloadExtension(extensionId: string): Promise<void>;

  getCustomEditors(): CustomEditorContribution[];
  getAITools(): AIToolContribution[];
}

// Platform service interface - implemented per platform
interface ExtensionPlatformService {
  // Where extensions live on this platform
  getExtensionsDirectory(): Promise<string>;

  // Load a JS module (dynamic import on web, require on Node, etc.)
  loadModule(path: string): Promise<ExtensionModule>;

  // Inject CSS into the document
  injectStyles(css: string): () => void;

  // File operations for extensions
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
}

interface LoadedExtension {
  manifest: ExtensionManifest;
  module: ExtensionModule;
  disposeStyles?: () => void;
  dispose: () => void;
}

interface ExtensionModule {
  activate?: (context: ExtensionContext) => Promise<void>;
  deactivate?: () => Promise<void>;
  components: Record<string, React.ComponentType<any>>;
  aiTools?: AIToolContribution[];
}
```

#### Platform Implementations

```typescript
// packages/electron/src/renderer/services/ElectronExtensionPlatformService.ts
class ElectronExtensionPlatformService implements ExtensionPlatformService {
  async getExtensionsDirectory() {
    return window.electronAPI.invoke('get-extensions-directory');
  }

  async loadModule(path: string) {
    // Use file:// protocol or custom nimbalyst-extension:// protocol
    return import(/* @vite-ignore */ `file://${path}`);
  }

  injectStyles(css: string) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return () => style.remove();
  }
  // ... file operations via IPC
}

// packages/capacitor/src/services/CapacitorExtensionPlatformService.ts
class CapacitorExtensionPlatformService implements ExtensionPlatformService {
  async getExtensionsDirectory() {
    // Use Capacitor Filesystem plugin
    return Filesystem.getUri({ directory: Directory.Data, path: 'extensions' });
  }

  async loadModule(path: string) {
    // Load from app bundle or downloaded location
    return import(/* @vite-ignore */ path);
  }
  // ... mobile-specific implementations
}
```

#### Phase 0 Tasks

1. **Define extension manifest schema**
2. **Create DatamodelLM package**
  - JSON schema for validation
  - TypeScript types for manifest

2. **Build ExtensionLoader**
  - Discover extensions in user directory
  - Load JS modules dynamically
  - Inject CSS stylesheets
  - Create extension context

3. **Integrate with existing registries**
  - ExtensionLoader feeds CustomEditorRegistry
  - ExtensionLoader feeds AIToolRegistry (new)
  - Existing registries don't need to change much

4. **Extension settings UI**
5. **Port DatamodelLM components**
  - List installed extensions
  - Enable/disable extensions
  - Show extension info (version, author, permissions)

#### Phase 0 Deliverables

**Runtime package (platform-agnostic):**
- `packages/runtime/src/extensions/ExtensionLoader.ts`
- `packages/runtime/src/extensions/ExtensionContext.ts`
- `packages/runtime/src/extensions/ExtensionPlatformService.ts` (interface)
- `packages/runtime/src/extensions/types.ts`
- Extension manifest JSON schema

**Electron package (platform implementation):**
- `packages/electron/src/renderer/services/ElectronExtensionPlatformService.ts`
- Extension management UI in settings

---

### Phase 1: DatamodelLM as External Extension

**Goal**: Build DatamodelLM as a standalone extension package that gets loaded by the extension system.

#### Extension Package Location

- Development: Separate directory (e.g., `~/sources/datamodellm-extension/`)
- For testing: Symlink into `~/Library/Application Support/@nimbalyst/extensions/`

#### Phase 1 Tasks

1. **Create extension package structure**
  - Separate directory (not in Nimbalyst monorepo)
  - package.json with build scripts
  - manifest.json declaring capabilities
  - Vite/esbuild config for bundling

  - Copy from `/Users/ghinkle/sources/datamodellm/`
  - Adapt Zustand store for file-based model
  - Create DatamodelLMEditor implementing CustomEditorProps
  - Bundle with dependencies (React Flow, Zustand)

3. **Export extension module**

```typescript
// src/index.ts
import { DatamodelLMEditor } from './DatamodelLMEditor';
import { aiTools } from './aiTools';

export const activate = async (context: ExtensionContext) => {
  // Any initialization
};

export const deactivate = async () => {
  // Cleanup
};

export const components = {
  DatamodelLMEditor,
};

export { aiTools };
```

4. **Theme integration via CSS variables**
  - Extension CSS uses Nimbalyst's CSS variable names
  - No hardcoded colors - inherits theme automatically

5. **Install for testing**
6. **Theme integration**
  - Symlink extension to user extensions directory
  - Verify it loads and `.datamodel` files work

#### File Format

```json
{
  "version": 1,
  "database": "postgres",
  "entities": [...],
  "relationships": [...],
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "entityViewMode": "standard"
}
```

#### Phase 1 Deliverables

- Separate `datamodellm-extension/` project
- Extension loads dynamically from user extensions directory
- `.datamodel` files open in visual editor
- Not compiled into Nimbalyst - truly external

---

### Phase 2: AI Tool Integration

**Goal**: Enable Claude to create and modify data models conversationally.

#### Current State

- AI tools are defined in providers (ClaudeCodeProvider, etc.)
- No extension point for custom tools
- DatamodelLM has 6 existing tools we want to expose

#### Required Changes

1. **Define AI tool extension interface**

```typescript
interface ExtensionAITool {
  name: string;
  description: string;
  parameters: JSONSchema;
  handler: (params: any, context: AIToolContext) => Promise<AIToolResult>;
}

interface ExtensionAIContext {
  tools: ExtensionAITool[];
  contextProvider?: () => Promise<string>;
  instructions?: string;
}
```

2. **Create tool registry**

```typescript
class AIToolRegistry {
  register(extensionId: string, tool: ExtensionAITool): void;
  getTools(): ExtensionAITool[];
  invoke(toolName: string, params: any, context: AIToolContext): Promise<AIToolResult>;
}
```

3. **Integrate with AI providers**
  - Modify AI service to aggregate tools from registry
  - Add tool definitions to system prompt
  - Route tool calls to registered handlers

4. **DatamodelLM tools to expose**

| Tool | Description |
| --- | --- |
| `create_datamodel` | Create a new .datamodel file |
| `create_entity` | Add entity to current data model |
| `update_entity` | Modify entity properties/fields |
| `delete_entity` | Remove entity (and cascade relationships) |
| `create_relationship` | Connect two entities |
| `update_relationship` | Modify relationship cardinality/actions |
| `delete_relationship` | Remove relationship |
| `export_datamodel` | Export to SQL/JSON Schema/DBML |

5. **Tool execution flow**

```
User: "Add a Users table with id, email, and name"
     ↓
Claude Code receives tool definitions in system prompt
     ↓
Claude calls: create_entity({ name: "Users", fields: [...] })
     ↓
AIToolRegistry.invoke("create_entity", params, context)
     ↓
DatamodelLM tool handler updates store
     ↓
UI updates reactively via Zustand
     ↓
File marked dirty → auto-save triggers
```

#### Phase 2 Deliverables

- `packages/runtime/src/ai/AIToolRegistry.ts`
- Tool integration in ClaudeCodeProvider
- DatamodelLM tools exposed and functional
- AI can create/modify data models conversationally

---

### Phase 3: Context Layering

**Goal**: AI understands what data models exist and their current state.

#### Tasks

1. **Context provider for DatamodelLM**

```typescript
const datamodelContextProvider = async (context: ExtensionContext): Promise<string> => {
  const workspace = context.workspace;
  const datamodels = await findFiles(workspace, '*.datamodel');

  if (datamodels.length === 0) return '';

  const summaries = await Promise.all(datamodels.map(async (path) => {
    const content = await readFile(path);
    const model = JSON.parse(content);
    return `- ${basename(path)}: ${model.entities.length} entities, ${model.relationships.length} relationships`;
  }));

  return `This workspace contains ${datamodels.length} data model(s):\n${summaries.join('\n')}`;
};
```

2. **Active document context**
  - When a `.datamodel` file is active, include its schema in context
  - Entity names, fields, relationships available to AI

3. **Instructions injection**

```typescript
const datamodelInstructions = `
You have access to data modeling tools for designing database schemas.
Use the create_entity tool to add tables, and create_relationship for connections.
Always create explicit relationships - foreign key fields alone are not enough.
`;
```

#### Phase 3 Deliverables

- Context provider integrated with AI service
- Active data model schema available in AI context
- Workspace-level data model awareness

---

### Phase 4: Advanced Features

**Goal**: Polish and enhance the integration.

#### Tasks

1. **Toolbar integration**
  - Custom toolbar for data model files
  - View mode selector (full/standard/minimal/compact)
  - Export dropdown
  - Undo/redo buttons

2. **File tree integration**
  - Custom icon for `.datamodel` files
  - "New Data Model" context menu option

3. **Export to document**
  - Insert SQL DDL as code block in markdown
  - Insert JSON Schema as code block
  - Link data model in markdown (like mockup references)

4. **History integration**
  - Use Nimbalyst's document history for data models
  - Snapshots stored in history system

5. **Collaborative potential** (future)
  - Data model files are JSON, could support CRDT merge

#### Phase 4 Deliverables

- Polished toolbar and UI
- File tree enhancements
- Export-to-document workflow
- History system integration

---

## API Design Decisions

### Decision 1: Extension System Location

**Question**: Where does the extension system live?

**Decision**: Core extension system in `packages/runtime/`, platform implementations in platform packages.

```
packages/runtime/src/extensions/
├── ExtensionLoader.ts        # Platform-agnostic loader
├── ExtensionContext.ts       # Context provided to extensions
├── types.ts                  # Interfaces, manifest types
└── ExtensionPlatformService.ts  # Interface for platform abstraction

packages/electron/src/renderer/services/
└── ElectronExtensionPlatformService.ts

packages/capacitor/src/services/  (future)
└── CapacitorExtensionPlatformService.ts
```

**Why**: Extensions should work on both Electron (desktop) and Capacitor (mobile). The runtime package is the shared foundation.

### Decision 2: Extension Loading Strategy

**Question**: How do we load extension code at runtime?

**Options considered**:
1. Dynamic `import()` of JS modules
2. Web Workers with message passing
3. iframes with postMessage
4. Node.js `require()` in main process, IPC to renderer

**Decision**: Dynamic `import()` via platform service.
- Extensions are ES modules bundled with their dependencies
- Platform service handles the actual import (different on Electron vs Capacitor)
- React components can be directly used (same React instance via externals)
- Simpler than worker/iframe isolation for v1

**Trade-off**: Less isolation, but simpler. Can add sandboxing later.

### Decision 3: Dependency Management

**Question**: How do extensions use React, Zustand, etc.?

**Decision**: Mark common dependencies as externals in extension bundler.
- Extensions don't bundle React, ReactDOM, Zustand
- Host app provides these at runtime
- Reduces bundle size, avoids version conflicts
- Extension bundler config marks these as `external`

```javascript
// Extension's vite.config.js
export default {
  build: {
    rollupOptions: {
      external: ['react', 'react-dom', 'zustand', '@xyflow/react'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
        }
      }
    }
  }
}
```

### Decision 4: File-Based vs Project-Based Models

**Question**: DatamodelLM standalone supports multiple "projects" with chat history. How do we handle this?

**Decision**: File-based approach.
- One `.datamodel` file = one data model
- Chat history is part of the AI session, not the data model file
- Simpler mental model: files are the unit of work
- Matches Nimbalyst's document-centric paradigm

### Decision 5: Where Does State Live?

**Question**: Zustand store vs Nimbalyst's document state management?

**Decision**: Local Zustand store per editor instance.
- Editor maintains its own reactive state
- State serializes to/from file content
- Nimbalyst handles file I/O, dirty tracking, saves
- Similar to how MockupViewer works

### Decision 6: How Are AI Tools Registered?

**Question**: Static registration vs dynamic discovery?

**Decision**: Dynamic registration when extension loads.
- ExtensionLoader discovers tools from loaded extension module
- Tools automatically available when extension is enabled
- Tools removed when extension is disabled/unloaded
- Scoped by extension ID for namespacing

### Decision 7: Tool Execution Boundary

**Question**: Do tools execute in main process or renderer?

**Decision**: Renderer process with IPC for file operations.
- Tool handlers run in renderer (direct store access)
- File creation uses existing IPC (`window.electronAPI.createFile`)
- Keeps tool logic close to UI for reactivity

---

## Technical Risks

### Risk 1: Dynamic Module Loading in Electron

**Mitigation**: Test dynamic `import()` with file:// URLs early. May need to configure CSP or use custom protocol.

### Risk 2: React Version Conflicts

**Mitigation**: Extensions mark React as external; host provides single instance. Test with actual extension build.

### Risk 3: CSS Isolation

**Mitigation**: Extension CSS uses scoped class names or CSS modules. Test for style bleed.

### Risk 4: Extension Security

**Mitigation**: For v1, trust extensions (similar to VS Code). Add permission system for v2.

### Risk 5: Hot Reload During Development

**Mitigation**: Implement extension reload without app restart. May need file watcher on extension directory.

---

## Success Criteria

1. **Extension system lives in runtime package** - Platform-agnostic core
2. **Extension loads from external directory** - Not compiled into app
3. **`.datamodel`**** files open in visual editor** with full canvas functionality
4. **AI can create and modify data models** using natural language
5. **Theme integration works** across light/dark/crystal-dark
6. **Export works** to SQL, JSON Schema, DBML
7. **File operations work** (new, save, autosave, history)
8. **Extension can be disabled/enabled** from settings
9. **API patterns are generalizable** to other extensions
10. **Same extension could work on Capacitor** - No Electron-specific APIs in extension code

---

## Open Questions

1. **Should we support inline data model references in markdown?**
  - Like MockupNode, could have DatamodelNode for embedding diagrams
  - Defer to Phase 4 or later

2. **How do we version the extension API?**
  - Extensions may break with Nimbalyst updates
  - Need manifest field for API version compatibility
  - **Recommendation**: Add `apiVersion` to manifest, validate on load

3. **Where do extension settings live?**
  - Global settings? Per-workspace?
  - **Recommendation**: Start with global, add workspace-level later

---

## Implementation Order

```
Phase 0: Extension System Infrastructure
├── Define manifest schema and types
├── Build ExtensionLoader (discover, load, unload)
├── Integrate with CustomEditorRegistry
├── Extension management UI in settings
└── Test with minimal "hello world" extension

Phase 1: DatamodelLM Extension Package
├── Create separate extension project
├── Port components from datamodellm/
├── Adapt store for file-based model
├── Build and bundle extension
├── Install via symlink, test loading
└── Theme integration

Phase 2: AI Tool Integration
├── Design AIToolRegistry
├── Integrate with AI service
├── Implement DatamodelLM tools in extension
└── Test conversational workflow

Phase 3: Context Layering
├── Implement context provider in extension
├── Active document context
├── Instructions injection
└── Polish and testing

Phase 4: Advanced Features
├── Toolbar and UI polish
├── File tree integration
├── Export to document
└── Documentation
```

## References

- DatamodelLM source: `/Users/ghinkle/sources/datamodellm/`
- Nimbalyst extension design: `/design/Extensions/nimbalyst-extension-system.md`
- Nimbalyst extension API: `/design/Extensions/nimbalyst-extension-api.md`
- CustomEditorRegistry: `/packages/electron/src/renderer/components/CustomEditors/`
- MockupViewer (reference implementation): `/packages/electron/src/renderer/components/CustomEditors/MockupEditor/`
