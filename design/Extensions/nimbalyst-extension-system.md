---
planStatus:
  planId: plan-nimbalyst-extensions
  title: Nimbalyst Extension System - Comprehensive Application Extensions
  status: in-development
  planType: system-design
  priority: high
  owner: ghinkle
  stakeholders:
    - ghinkle
  tags:
    - architecture
    - extensions
    - api
    - ui
    - database
    - menus
  progress: 60
  startDate: "2025-02-01"
  updated: "2025-12-12T00:00:00.000Z"
---
# Nimbalyst Extension System - Comprehensive Application Extensions

## Implementation Status

The Nimbalyst Extension System is now partially implemented and functional. The first extension (DatamodelLM) is loading and working.

### What's Working

- **Extension Discovery & Loading**: Extensions are discovered from `~/Library/Application Support/@nimbalyst/electron/extensions/`
- **Custom Editors**: Extensions can register custom editors for specific file types (e.g., `.prisma` files)
- **AI Tools**: Extensions can expose AI tools that are integrated with Claude Code via MCP
- **AI Diff Mode**: Custom editors can opt-in to showing visual diffs when AI agents edit their files
- **Host Callbacks**: Structured callback interface for editor-host communication
- **New File Menu**: Extensions can add items to the "New File" menu
- **Theme Integration**: Extension CSS uses host CSS variables for theme compatibility
- **Hot Reload**: Extensions can be reloaded without restarting the app

### Reference Implementation

**DatamodelLM** is the first extension built on this system:
- Location: `packages/extensions/datamodellm/`
- File type: `.prisma` (Prisma schema files)
- Custom editor: Visual entity-relationship diagram canvas
- AI tools: `get_schema`, `capture_screenshot`
- Uses React Flow for the diagram canvas

## Executive Summary

The Nimbalyst Extension System allows developers to extend the entire application - not just the editor. Extensions can:

- **Provide completely custom editor systems** for specialized file types
- **Expose AI tools** that Claude Code can invoke during conversations
- Register new file types with custom icons and "New File" menu entries
- Access the file system (with permission)
- Integrate with the host's React, Zustand, and React Flow instances

The system is platform-agnostic - core extension infrastructure lives in `packages/runtime/` while platform-specific implementations live in the platform packages.

## Current Architecture

### Extension Package Structure

```
extension-name/
├── manifest.json          # Extension manifest (required)
├── package.json           # npm package metadata
├── dist/
│   ├── index.js          # Bundled extension entry point
│   └── index.css         # Bundled styles (optional)
└── src/                  # Source code (not shipped)
    └── index.tsx         # Entry point
```

### Extension Location

Extensions are loaded from:
- **User extensions directory**: `~/Library/Application Support/@nimbalyst/electron/extensions/`

Each extension lives in its own subdirectory with a `manifest.json` file.

### Core Files

The extension system is implemented across these files:

| File | Purpose |
| --- | --- |
| `packages/runtime/src/extensions/types.ts` | TypeScript type definitions |
| `packages/runtime/src/extensions/ExtensionLoader.ts` | Discovery, loading, lifecycle |
| `packages/runtime/src/extensions/ExtensionPlatformService.ts` | Platform abstraction interface |
| `packages/runtime/src/extensions/ExtensionAIToolsBridge.ts` | AI tool registration and MCP integration |
| `packages/electron/src/renderer/extensions/ExtensionEditorBridge.ts` | Custom editor integration |

## Extension Manifest

The `manifest.json` declares extension capabilities:

```json
{
  "id": "com.nimbalyst.datamodellm",
  "name": "DatamodelLM",
  "version": "1.0.0",
  "description": "AI-assisted data modeling",
  "author": "Nimbalyst",
  "main": "dist/index.js",
  "styles": "dist/index.css",
  "apiVersion": "1.0.0",

  "permissions": {
    "filesystem": true,
    "ai": true
  },

  "contributions": {
    "customEditors": [
      {
        "filePatterns": ["*.prisma"],
        "displayName": "Data Model Editor",
        "component": "DatamodelLMEditor"
      }
    ],
    "aiTools": [
      "datamodellm.get_schema",
      "datamodellm.capture_screenshot"
    ],
    "fileIcons": {
      "*.prisma": "database"
    },
    "newFileMenu": [
      {
        "extension": ".prisma",
        "displayName": "Data Model",
        "icon": "database",
        "defaultContent": "// Default content..."
      }
    ]
  }
}
```

## Extension Module Exports

Extensions export a module with specific exports:

```typescript
// Extension entry point (index.tsx)
import { MyEditorComponent } from './components/MyEditor';
import { myAITools } from './aiTools';

// Called when extension loads
export async function activate(context: ExtensionContext) {
  console.log('Extension activated');
}

// Called when extension unloads
export async function deactivate() {
  console.log('Extension deactivated');
}

// Components referenced in manifest.json
export const components = {
  MyEditorComponent,
};

// AI tools for Claude Code
export const aiTools = myAITools;
```

## Dependency Management

Extensions use the host's React, Zustand, and React Flow instances. The extension bundler (Vite) marks these as externals:

```javascript
// vite.config.ts
export default {
  build: {
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'zustand',
        '@xyflow/react',
      ],
    },
  },
};
```

At runtime, the host provides these dependencies via `window.__nimbalyst_extensions`:

```typescript
window.__nimbalyst_extensions = {
  react: React,
  'react-dom': ReactDOM,
  'react/jsx-runtime': jsxRuntime,
  zustand: zustand,
  '@xyflow/react': xyflowReact,
};
```

## Module Loading and Bundling

Extensions are loaded as ES modules at runtime. Understanding the bundling requirements is critical for extensions to work correctly in both development and production builds.

### JSX Runtime Considerations

**Critical:** Extensions must be built in **production mode** to work correctly in production Nimbalyst builds.

The issue: React's JSX transform has two variants:
- **Development**: Uses `jsxDEV` from `react/jsx-dev-runtime`
- **Production**: Uses `jsx` from `react/jsx-runtime`

In production builds of the host app, `jsxDEV` is `undefined`. If an extension is built in development mode, it will import `jsxDEV` and crash at runtime with cryptic errors like "T is not a function" in decorator methods.

**Required vite.config.ts settings:**

```typescript
export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
      jsxImportSource: 'react',
    }),
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  mode: 'production',  // Critical: ensures jsx-runtime, not jsx-dev-runtime
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.tsx'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'zustand',
        '@xyflow/react',
        // ... other host-provided dependencies
      ],
    },
  },
});
```

### Host Dependency Exposure

The host exposes dependencies using **namespace imports** to prevent tree-shaking:

```typescript
// ExtensionPlatformServiceImpl.ts
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';

window.__nimbalyst_extensions = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react/jsx-dev-runtime': jsxDevRuntime,  // Fallback for dev builds
  // ...
};
```

Using `import * as` instead of named imports (`import { jsx }`) ensures the entire module is included regardless of tree-shaking optimizations in the host build.

### Extension Loading Sequence

1. **Discovery**: Extension manifests are scanned from the extensions directory
2. **Node Registration**: Extensions that contribute Lexical nodes must be loaded before the editor mounts
3. **Module Execution**: Extension bundles are loaded via dynamic `import()`
4. **Activation**: The extension's `activate()` function is called with the context

**Important:** The host app guards editor rendering until extensions are loaded:

```typescript
// App.tsx
const [extensionsReady, setExtensionsReady] = useState(false);

useEffect(() => {
  registerExtensionSystem()
    .finally(() => setExtensionsReady(true));
}, []);

if (!extensionsReady) {
  return <div style={{ height: '100vh' }} />;
}
```

This ensures Lexical nodes contributed by extensions are registered before the editor attempts to deserialize documents that may contain them.

### Common Bundling Issues

| Problem | Symptom | Solution |
| --- | --- | --- |
| Wrong JSX runtime | "T is not a function" or undefined errors in `decorate` | Set `mode: 'production'` in vite config |
| Missing external | "Cannot find module 'react'" | Add to `rollupOptions.external` |
| Tree-shaken exports | Host module missing expected exports | Use `import * as` namespace imports |
| Node not registered | "Attempted to create node X that was not configured" | Ensure extension loads before editor mounts |
| CSS variables missing | Unstyled or broken themes | Use host CSS variables, not hardcoded colors |

### Verifying Extension Bundles

After building, verify the extension imports from `react/jsx-runtime` (not `jsx-dev-runtime`):

```bash
head -5 dist/index.js
# Should show: import { jsx as _, jsxs as X } from "react/jsx-runtime";
# NOT: import { jsxDEV } from "react/jsx-dev-runtime";
```

## Future Work

The following features are planned but not yet implemented:

- **Application-level menus**: Register items in File, Edit, View menus
- **Command palette**: Add commands to the command palette
- **Database access**: Extensions with their own database tables
- **Settings panels**: Extension-specific settings UI
- **Context providers**: Layer extension context into AI prompts
- **Editor extensions**: Lexical nodes and markdown transformers

---

## Original Design Goals

The following sections describe the full vision for the extension system, including features not yet implemented.

## Goals

1. **Comprehensive Extension API** - Extensions can modify all aspects of the app, not just the editor
2. **Application-Level Integration** - Menus, commands, dialogs, database, settings, UI panels
3. **Custom Editor Systems** - Extensions can register entirely custom editors for specific file types
4. **AI Integration** - Extensions can expose tools and context to AI agents
5. **Wrap Lexical Extensions** - Use Lexical's extension API for editor features, add our own features on top
6. **Strong TypeScript APIs** - Fully typed extension interfaces with IntelliSense support
7. **Security & Sandboxing** - Safe execution of third-party code with permission system
8. **Developer Experience** - Easy to create, test, debug, and distribute extensions
9. **Marketplace Ready** - Designed for future extension marketplace/registry

## Proposed Solution: Nimbalyst Extension System

Create a multi-layered extension architecture:

### Layer 1: Application Extensions (New)
Top-level extensions that can modify the entire app:
- Register menu items, commands, keyboard shortcuts
- Add dialogs, panels, and UI components
- Create database tables and migrations
- Register IPC handlers and background services
- Integrate with project system and file watchers
- **Register custom file type handlers and editors**
- **Expose AI tools and context layers**

### Layer 2: Editor Extensions (Wrapper around Lexical)
Editor-specific extensions that wrap Lexical's API:
- Register Lexical nodes and transformers
- Add markdown import/export support
- Provide Component Picker commands
- Register editor commands and decorators

### Layer 3: Custom Editor Systems (New)
Extensions that provide completely custom editor experiences:
- **Register custom editor components** for specific file types
- **Custom toolbar and UI chrome** specific to the editor
- **Custom save/load handlers** for specialized formats
- **Integration with AI** for domain-specific operations
- Example: WireframeLM editor for .wireframe.html files

### Layer 4: Lexical Extensions (Direct Passthrough)
Raw Lexical extension API for advanced use cases:
- Direct access to Lexical lifecycle phases
- Low-level editor manipulation
- Performance-critical operations

## Architecture Overview

**For complete TypeScript API definitions, see **[nimbalyst-extension-api.md](./nimbalyst-extension-api.md)

The extension system is built around these core concepts:

### Extension Registration

Extensions declare capabilities through a structured manifest including:

- **Metadata**: ID, name, version, author, description
- **Permissions**: Database, filesystem, network, IPC, shell access
- **Lifecycle hooks**: `activate()` and `deactivate()` for setup/cleanup
- **Contributions**:
  - Menus and commands
  - UI panels and dialogs
  - Database migrations
  - Settings
  - Custom editors for specific file types
  - AI tools and context
  - Lexical editor nodes and transformers

### Extension Context

When an extension activates, it receives a rich `ExtensionContext` providing permission-based API access:

- **App API**: Register commands/menus, show dialogs, workspace events
- **Database API**: Queries, transactions (if permitted)
- **UI API**: Panels, notifications, status bar items
- **Settings API**: Get/set extension settings with change notifications
- **Filesystem API**: Read/write files, file watchers (if permitted)
- **Editor API**: Access active Lexical editor, editor change events

### Extension Manager

The `NimbalystExtensionSystem` manages the extension lifecycle:

- **Registration**: Validates, creates context, activates extension
- **Aggregation**: Collects contributions from all extensions
- **Custom Editor Routing**: Matches files to appropriate custom editors
- **AI Integration**: Gathers AI tools and context layers
- **Cleanup**: Proper deactivation and resource disposal

## Extension Examples

The extension system supports a wide range of use cases, from simple editor enhancements to complex application-level features with AI integration.

**For complete working examples, see the **[**Extension Examples**](./nimbalyst-extension-api.md#example-extensions)** section in the API documentation.**

Example types covered:

### 1. Simple Editor Extension (Mermaid)
- Lexical node registration
- Markdown transformers
- Component Picker commands
- Minimal permissions needed

### 2. Full Application Extension (Task Manager)
- Database access with migrations
- Custom UI panels in sidebar
- Menu and command contributions
- Settings integration
- Full application lifecycle hooks

### 3. Hybrid Extension (Word Counter)
- Combines editor and app features
- Editor event listeners
- Status bar integration
- Database persistence
- Reactive UI updates

### 4. Custom Editor with AI Integration (WireframeLM)
- Custom editor component for `.wireframe.html` files
- AI tools (`create_wireframe`, `export_wireframe`)
- Dynamic AI context layering
- Screenshot attachments to AI
- Custom save/load handlers
- Specialized toolbar and menu items

These examples demonstrate the full spectrum of extension capabilities, from simple enhancements to complex multi-faceted features.

## Implementation Plan

### Phase 1: Core Extension System (Week 1-3)

**Tasks:**
1. Design and implement `NimbalystExtensionSystem` class
2. Define `NimbalystExtension` interface and all contribution types
3. Implement `ExtensionContext` with permission-based API access
4. Create extension validation and lifecycle management
5. Build permission system and sandboxing
6. Set up extension storage and isolation
7. Write comprehensive unit tests

**Deliverables:**
- `/packages/runtime/src/extensions/NimbalystExtensionSystem.ts`
- `/packages/runtime/src/extensions/types.ts`
- `/packages/runtime/src/extensions/ExtensionContext.ts`
- `/packages/runtime/src/extensions/permissions.ts`
- Test suite for extension lifecycle and permissions

### Phase 2: Application-Level Integration (Week 3-5)

**Tasks:**
1. Implement menu contribution system (File, Edit, View, Help menus)
2. Build command registry and command palette integration
3. Create panel contribution system (sidebar, bottom, modal)
4. Implement dialog API for extensions
5. Build settings contribution system
6. Create status bar item contribution
7. Add database migration system for extensions

**Deliverables:**
- Menu system integration
- Command palette with extension commands
- Panel rendering system
- Dialog API implementation
- Settings UI integration
- Database schema versioning for extensions

### Phase 3: Editor Integration Layer (Week 5-7)

**Tasks:**
1. Create editor extension wrapper over Lexical
2. Implement markdown transformer aggregation
3. Build Component Picker command integration
4. Add Lexical node registration from extensions
5. Implement editor event bridging to extension context
6. Test editor extensions work with app-level features

**Deliverables:**
- `EditorExtension` wrapper implementation
- Transformer aggregation system
- Component Picker integration
- Editor API in `ExtensionContext`
- Integration tests for editor + app features

### Phase 4: Convert Built-in Features (Week 7-10)

**Tasks:**
1. Convert Mermaid, Emoji, Collapsible to editor extensions
2. Convert Table, Images, Excalidraw to editor extensions
3. Build example app-level extension (Word Counter)
4. Build example full-featured extension (Task Manager)
5. Update app initialization to use extension system
6. Create backward compatibility layer for old plugins

**Deliverables:**
- All built-in editor features as extensions
- Example app-level extensions
- Updated application bootstrap
- Migration guide for existing plugins
- Backward compatibility shim

### Phase 5: Extension Loading & Distribution (Week 10-12)

**Tasks:**
1. Design extension package format (npm package, directory, or bundle)
2. Implement extension discovery and loading from user directories
3. Build extension installation/uninstallation UI
4. Create extension management settings panel
5. Add extension metadata display (version, author, description)
6. Implement extension update checking
7. Design extension marketplace/registry (future)

**Deliverables:**
- Extension loader implementation
- Extension package specification
- Extension management UI
- Installation/update system
- Marketplace design document

### Phase 6: Security & Developer Experience (Week 12-14)

**Tasks:**
1. Harden permission system and sandboxing
2. Add extension debugging tools and logging
3. Create extension development scaffolding CLI
4. Write comprehensive extension developer guide
5. Build extension testing utilities
6. Add extension performance monitoring
7. Create extension example templates

**Deliverables:**
- Security audit and hardening
- Extension developer CLI (`create-nimbalyst-extension`)
- Developer documentation
- Extension testing framework
- Example extension templates (simple editor, full app, hybrid)

## Benefits Over Current Plugin System

### What We Gain

1. **Comprehensive Application Integration**
  - Extensions can modify menus, not just editor
  - Add custom commands to command palette
  - Create panels, dialogs, and UI components
  - Access database for persistent extension data
  - Integrate with settings system
  - Add status bar items and notifications

2. **Custom Editor Systems**
  - Register completely custom editors for specific file types
  - Not limited to Lexical markdown editor
  - Custom save/load handlers for specialized formats
  - Custom toolbar and UI chrome per editor type
  - Examples: wireframe designers, diagram editors, data visualizers

3. **Deep AI Integration**
4. **Permission-Based Security**
5. **Permission-Based Security**
6. **Permission-Based Security**
  - Expose custom tools that AI agents can invoke
  - Layer extension-specific context into AI prompts
  - Send screenshots and attachments back to AI
  - Domain-specific instructions for AI understanding
  - Dynamic context based on workspace state
  - Enables conversational workflows with extension features

4. **Permission-Based Security**
  - Extensions request specific permissions
  - User can review and approve permissions
  - Sandboxed execution prevents malicious code
  - Per-extension storage isolation

3. **Proper Extension Lifecycle**
  - Activate/deactivate hooks for setup/cleanup
  - Extension context with rich APIs
  - Disposable pattern for cleanup
  - Error isolation (one extension can't crash app)

4. **Developer-Friendly APIs**
5. **Runtime Configuration**
  - Strongly-typed TypeScript interfaces
  - IntelliSense support throughout
  - Clear documentation and examples
  - Extension templates and scaffolding
  - Debugging tools and logging

5. **Distribution & Discovery**
  - npm package format for extensions
  - Extension marketplace (future)
  - Version management and updates
  - Installation UI built-in

6. **Editor Features (Still Supported)**
  - Wraps Lexical extension API
  - Markdown transformer support (fills Lexical gap)
  - Component Picker integration
  - Material Symbols icons
  - Markdown-first focus

### What We Keep

1. **All Current Editor Plugins** - converted to extensions
2. **Component Picker** - enhanced with extension commands
3. **Markdown Transformers** - still first-class citizens
4. **Backward Compatibility** - existing plugins continue to work
5. **Developer Productivity** - easier to build features as extensions

## Migration Strategy

### For Built-in Plugins

1. Create Nimbalyst extension version
2. Test extensively (unit tests + integration tests)
3. Update application initialization to register extension
4. Keep old plugin system for backward compatibility (deprecated)
5. Remove old plugin system after extension system is stable

### For Third-Party Plugin Authors

Provide comprehensive migration guide:

```typescript
// Before (old plugin system - editor only)
const MyPlugin: PluginPackage = {
  name: 'MyPlugin',
  Component: MyPluginComponent,
  nodes: [MyNode],
  transformers: [MY_TRANSFORMER],
  userCommands: [/* ... */],
};

// After (Nimbalyst extension - editor only, minimal changes)
const MyExtension: NimbalystExtension = {
  id: 'com.mycompany.my-plugin',
  name: 'My Plugin',
  version: '1.0.0',

  editor: {
    nodes: [MyNode],
    transformers: [MY_TRANSFORMER],
    componentCommands: [/* ... */],  // Renamed from userCommands
    lexical: {
      register: (editor) => {
        // Plugin logic here
      },
    },
  },
};

// Advanced (leveraging app-level features)
const MyAdvancedExtension: NimbalystExtension = {
  id: 'com.mycompany.my-advanced-plugin',
  name: 'My Advanced Plugin',
  version: '1.0.0',

  permissions: {
    database: true,  // Request database access
    filesystem: true,
  },

  activate: async (context) => {
    // Setup database tables
    await context.database!.execute(`
      CREATE TABLE IF NOT EXISTS my_plugin_data (
        id TEXT PRIMARY KEY,
        data TEXT
      )
    `);

    // Register custom commands
    context.app.registerCommand('my-plugin.show-panel', () => {
      context.ui.showPanel({
        id: 'my-panel',
        title: 'My Plugin Panel',
        component: MyPanelComponent,
      });
    });
  },

  menus: [
    {
      menu: 'view',
      items: [
        {
          id: 'my-plugin.show-panel',
          label: 'Show My Panel',
          command: 'my-plugin.show-panel',
          accelerator: 'CmdOrCtrl+Shift+M',
        },
      ],
    },
  ],

  editor: {
    nodes: [MyNode],
    transformers: [MY_TRANSFORMER],
    componentCommands: [/* ... */],
  },
};
```

## Risks & Mitigations

### Risk 1: Security Vulnerabilities in Third-Party Extensions
**Severity:** High
**Likelihood:** Medium (if marketplace opens)
**Mitigation:**
- Strict permission system with user approval
- Sandboxed execution environment
- Code review for marketplace extensions
- Rate limiting on API calls
- Extension signing and verification

### Risk 2: Performance Impact
**Severity:** Medium
**Likelihood:** Medium
**Mitigation:**
- Lazy loading of extension code
- Extension isolation prevents cascading failures
- Performance monitoring and budgets
- Disable misbehaving extensions automatically
- Benchmark common extension patterns

### Risk 3: API Surface Too Large
**Severity:** Medium
**Likelihood:** Medium
**Mitigation:**
- Start with minimal API surface
- Add APIs incrementally based on real use cases
- Version APIs to allow deprecation
- Clear documentation of stable vs experimental APIs

### Risk 4: Breaking Changes in Lexical
**Severity:** Low
**Likelihood:** Medium
**Mitigation:**
- Wrapper layer isolates extensions from Lexical changes
- Only expose stable Lexical APIs
- Update wrapper when Lexical changes
- Extensions use our APIs, not Lexical directly

### Risk 5: Migration Complexity
**Severity:** High
**Likelihood:** Medium
**Mitigation:**
- Incremental migration starting with simple plugins
- Maintain backward compatibility layer indefinitely if needed
- Comprehensive migration guide with examples
- Migration tooling/scripts to automate conversion

## Success Metrics

1. **All built-in features converted** to Nimbalyst extensions
2. **Zero regressions** in markdown import/export and editor features
3. **Application integration working** - menus, commands, panels, database all functional
4. **Third-party extension creation** - at least 3 example extensions demonstrating different capabilities
5. **Performance** - no measurable degradation from extension system
6. **Developer satisfaction** - extension creation is easier and more powerful than current plugins
7. **Test coverage** >85% for extension system core
8. **Documentation complete** - developer guide, API reference, examples

## Future Enhancements

### Short Term (3-6 months)
1. Extension marketplace/registry with search and discovery
2. Hot reloading for extension development
3. Extension debugging tools (inspector, profiler)
4. More extension APIs (theming, custom file types, export formats)
5. Extension templates in CLI (`create-nimbalyst-extension`)

### Medium Term (6-12 months)
1. Remote extensions (loaded from URLs)
2. Extension bundles (related extensions packaged together)
3. Collaborative extension development
4. Extension analytics (opt-in usage tracking)
5. Cloud sync for installed extensions

### Long Term (12+ months)
1. WebAssembly sandboxing for untrusted extensions
2. Extension versioning with automatic updates
3. Paid extensions marketplace
4. Extension recommendation engine
5. Contribute lessons learned back to Lexical community

## Documentation Requirements

1. **Extension Developer Guide** (comprehensive)
  - Getting started tutorial
  - Extension anatomy and structure
  - Application APIs (menus, commands, panels, database, settings)
  - Editor APIs (nodes, transformers, commands)
  - Permission system and security
  - Testing extensions
  - Publishing and distribution
  - Best practices and patterns

2. **API Reference** (complete)
3. **Extension Developer Guide**
  - `NimbalystExtension` interface
  - `ExtensionContext` and all sub-APIs
  - Contribution types (menu, command, panel, etc.)
  - Permission types
  - Lifecycle hooks (activate, deactivate)
  - Type definitions for TypeScript

2. **Migration Guide**
  - Converting old plugins to extensions
  - Breaking changes from plugin system
  - Backward compatibility notes
  - Migration tools and scripts
  - Before/after examples

3. **Architecture Documentation**
  - Extension lifecycle and loading
  - System design and layering
  - Permission system internals
  - Sandboxing and security model
  - Performance considerations
  - Comparison with VS Code extensions

4. **Example Extensions**
  - Simple editor extension (syntax highlighting)
  - App-level extension (word counter)
  - Full-featured extension (task manager)
  - Database extension (note linking)
  - UI extension (custom panel)

## References

### Internal Documentation
- Current plugin system: `/packages/rexical/docs/PLUGIN_SYSTEM.md`
- Lexical extension comparison: `/packages/rexical/docs/LEXICAL_EXTENSION_COMPARISON.md`

### External References
- [VS Code Extension API](https://code.visualstudio.com/api) - Inspiration for application-level APIs
- [Lexical Extension Docs](https://lexical.dev/docs/extensions/intro) - Editor-level extension system
- [Electron IPC](https://www.electronjs.org/docs/latest/api/ipc-main) - Communication between main/renderer
- [Chrome Extension APIs](https://developer.chrome.com/docs/extensions/reference/) - Permission system inspiration

### Related Work
- Obsidian plugins - Community-driven markdown editor extensions
- Notion integrations - Database and UI extensions
- Atom packages - Comprehensive editor extension system (archived)
- JetBrains plugins - IDE extension marketplace

## Conclusion

The Nimbalyst Extension System is a comprehensive platform for extensibility that goes far beyond just editor plugins:

**Core Value Propositions:**
1. **True Application Extensions** - not just editor nodes, but menus, commands, panels, database, settings, and more
2. **Custom Editor Systems** - extensions can provide completely custom editors for specialized file types
3. **Deep AI Integration** - expose tools, layer context, send attachments to AI conversations
4. **Wraps Lexical** - uses Lexical's extension API where it makes sense, adds our own layers on top
5. **Fills the Gaps** - markdown transformers, Component Picker, application integration
6. **Security First** - permission-based system prevents malicious extensions
7. **Developer Friendly** - strongly typed APIs, examples, templates, debugging tools
8. **Marketplace Ready** - designed for discovery, installation, and distribution

**Why This Approach:**
- Nimbalyst needs more than editor plugins - we need app extensions
- Lexical extensions are excellent for editor concerns but insufficient for app-level features
- **Real-world validation:** The WireframeLM system demonstrates the need for custom editors and AI integration
- By wrapping Lexical and adding our own layers, we get the best of both worlds
- AI integration enables extensions to deeply participate in conversational workflows
- This enables a vibrant extension ecosystem that can truly customize the entire app

**Key Learnings from WireframeLM:**
- Extensions should be able to register completely custom editor UIs, not just Lexical nodes
- AI tools are a natural extension point - extensions expose domain-specific capabilities
- Context layering allows extensions to make AI aware of their features and workspace state
- Attachments (screenshots, exports) are essential for visual extension types
- Custom file type handlers need custom save/load logic, not just text

This is the foundation for making Nimbalyst a platform, not just an editor.
