# Extension Panels

Panels are non-file-based UIs that extensions can contribute to Nimbalyst. Unlike custom editors (which are tied to file types), panels provide persistent interfaces for tools like database browsers, deployment dashboards, home automation controls, and more.

## Overview

Panels can:
- Add buttons to the navigation gutter
- Render in the sidebar alongside the file tree
- Take over the full screen (like Agent mode)
- Float as modals or overlays
- Expose AI tools that share state with the UI
- Have their own configuration in the Settings screen

## Quick Start

### 1. Declare panels in manifest.json

```json
{
  "id": "com.example.database-browser",
  "name": "Database Browser",
  "contributions": {
    "panels": [
      {
        "id": "database",
        "title": "Database",
        "icon": "storage",
        "placement": "sidebar",
        "aiSupported": true
      }
    ],
    "settingsPanel": {
      "component": "DatabaseSettings",
      "title": "Database Connections"
    }
  }
}
```

### 2. Export panel components

```typescript
// index.tsx
import { DatabasePanel } from './DatabasePanel';
import { DatabaseSettings } from './DatabaseSettings';

export const panels = {
  database: {
    component: DatabasePanel,
  },
};

export const settingsPanel = {
  DatabaseSettings,
};
```

### 3. Implement the panel component

```typescript
// DatabasePanel.tsx
import type { PanelHostProps } from '@nimbalyst/extension-sdk';

export function DatabasePanel({ host }: PanelHostProps) {
  return (
    <div className="database-panel">
      <h2>Database Browser</h2>
      <p>Connected to workspace: {host.workspacePath}</p>
    </div>
  );
}
```

## Panel Contribution Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `id` | string | Yes | Unique identifier within the extension |
| `title` | string | Yes | Display title for gutter tooltip |
| `icon` | string | Yes | Material icon name or emoji |
| `placement` | enum | Yes | `"sidebar"`, `"fullscreen"`, or `"floating"` |
| `aiSupported` | boolean | No | Enable AI context sharing (default: false) |
| `activationEvents` | string[] | No | When to activate (default: `["onPanel"]`) |
| `order` | number | No | Sort order in gutter (default: 100) |

## Placement Modes

### Sidebar (`placement: "sidebar"`)

Panel renders in the sidebar area, alongside or replacing the file tree.

- Gutter button appears in the middle section
- Good for: database browsers, git panels, search results
- Can coexist with file tree via tabs

### Fullscreen (`placement: "fullscreen"`)

Panel takes over the entire main content area.

- Gutter button switches to this mode
- Good for: dashboards, monitoring consoles, welcome screens
- Similar to how Agent mode works today

### Floating (`placement: "floating"`)

Panel renders at app level as a modal or overlay.

- No gutter button (extension controls visibility)
- Good for: command palettes, quick pickers, notifications
- Uses the existing hostComponents mechanism internally

## PanelHost Interface

Panels receive a `PanelHost` object that provides communication with the host application.

```typescript
interface PanelHost {
  // Identity
  readonly panelId: string;      // Full ID: extensionId.panelId
  readonly extensionId: string;

  // Environment
  readonly theme: string;
  readonly workspacePath: string;
  readonly isSettingsOpen: boolean;

  // Theme changes
  onThemeChanged(callback: (theme) => void): () => void;

  // Navigation
  openFile(path: string): void;      // Open a file in the editor
  openPanel(panelId: string): void;  // Switch to another panel
  close(): void;                     // Close floating panel

  // Settings
  openSettings(): void;
  closeSettings(): void;

  // AI context (only if aiSupported: true)
  readonly ai?: PanelAIContext;
}
```

## AI Tool Integration

When `aiSupported: true`, panels can share state with AI tools:

### Setting context from the panel

```typescript
function DatabasePanel({ host }: PanelHostProps) {
  const [activeConnection, setActiveConnection] = useState(null);

  useEffect(() => {
    // Update AI context when selection changes
    host.ai?.setContext({
      activeConnection: activeConnection?.name,
      database: activeConnection?.path,
    });
  }, [activeConnection, host.ai]);

  return <ConnectionList onSelect={setActiveConnection} />;
}
```

### Accessing context in AI tools

```typescript
export const aiTools = [
  {
    name: 'database.query',
    description: 'Execute a SQL query',
    async handler(args, context) {
      // Access panel state via shared atoms or context
      const connection = getActiveConnection();
      if (!connection) {
        return { error: 'No active connection. Open the Database panel first.' };
      }
      return await executeQuery(connection, args.sql);
    }
  }
];
```

### Shared state pattern (recommended)

Use Jotai atoms to share state between panel and AI tools:

```typescript
// state.ts
import { atom, createStore } from 'jotai';

export const extensionStore = createStore();
export const activeConnectionAtom = atom(null);
export const queryResultAtom = atom(null);

// Helper for AI tools
export function getActiveConnection() {
  return extensionStore.get(activeConnectionAtom);
}

// Panel component
function DatabasePanel({ host }) {
  const [connection, setConnection] = useAtom(activeConnectionAtom, { store: extensionStore });
  // ...
}

// AI tool
async function handler(args) {
  const connection = getActiveConnection();
  const result = await query(connection, args.sql);

  // Update panel to show results
  extensionStore.set(queryResultAtom, result);

  return result;
}
```

## Extension Storage

Extensions have access to namespaced storage for configuration:

```typescript
interface ExtensionStorage {
  // Per-workspace storage
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;

  // Global storage (shared across workspaces)
  getGlobal<T>(key: string): T | undefined;
  setGlobal<T>(key: string, value: T): Promise<void>;
  deleteGlobal(key: string): Promise<void>;

  // Secret storage (system keychain)
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
```

All keys are automatically namespaced by extension ID. Use cases:

- **Workspace storage**: Last selected item, view state
- **Global storage**: Configured connections, preferences
- **Secret storage**: Passwords, API tokens (stored in system keychain)

## Settings Routes and Nested Panels

Extensions with a substantial configuration or management surface can contribute one or more first-class rows to the Settings sidebar. Each route chooses application or project scope:

```json
{
  "contributions": {
    "settingsRoutes": [
      {
        "id": "connections",
        "scope": "project",
        "label": "Database Connections",
        "group": "Extensions",
        "icon": "storage",
        "order": 50,
        "component": "DatabaseSettings"
      }
    ]
  }
}
```

Route ids are unique within the extension; the host namespaces them as `ext:<extensionId>:<id>`. `scope` must be `"application"` or `"project"`. `group` defaults to `"Extensions"`, `icon` to `"extension"`, and `order` to `100`.

Route components use the existing `settingsPanel` module export:

```typescript
export const settingsPanel = {
  DatabaseSettings: ({ storage, theme, workspacePath, projectTarget }) => (
    <div>
      <h2>Database Connections</h2>
      <p>Workspace: {workspacePath}</p>
    </div>
  ),
};
```

Project-scoped routes receive `workspacePath` for local workspaces plus `projectTarget`, which can also identify an organization project. Application-scoped routes omit both fields. All settings components receive `storage`, `theme`, and the optional `callBackendTool` bridge.

For a small configuration form that does not need its own sidebar row, the legacy `settingsPanel` contribution remains available under Settings → Extensions → Installed:

```typescript
// manifest.json
{
  "contributions": {
    "settingsPanel": {
      "component": "DatabaseSettings",
      "title": "Database Connections",
      "icon": "storage"
    }
  }
}

// index.tsx
export const settingsPanel = {
  DatabaseSettings: ({ storage, theme }) => (
    <div>
      <h2>Database Connections</h2>
      {/* Manage connections here */}
    </div>
  ),
};
```

Nested settings panels receive:
- `storage`: ExtensionStorage instance
- `theme`: Current application theme

They may also receive `callBackendTool`. They do not receive project context; use a project-scoped `settingsRoutes` contribution when the surface is per-repository.

## Panel Exports

Full structure of panel exports from extension module:

```typescript
export const panels = {
  'panel-id': {
    // Required: Main panel component
    component: MyPanel,

    // Optional: Custom gutter button
    gutterButton: MyGutterButton,

    // Optional: Settings component in panel header
    settingsComponent: MyPanelSettings,
  },
};
```

### Custom Gutter Button

Override the default gutter button:

```typescript
function MyGutterButton({ isActive, onActivate, theme }: PanelGutterButtonProps) {
  return (
    <button onClick={onActivate} className={isActive ? 'active' : ''}>
      <span className="icon">DB</span>
      <span className="badge">3</span>
    </button>
  );
}
```

### Panel Settings Component

Quick settings that appear in the panel header:

```typescript
function MyPanelSettings({ host }: PanelHostProps) {
  return (
    <select>
      <option>Connection 1</option>
      <option>Connection 2</option>
    </select>
  );
}
```

## Complete Example

See the SQLite Browser extension for a complete implementation:

```
packages/extensions/sqlite-browser/
  manifest.json           # Panel and settings declarations
  src/
    index.tsx             # Main exports
    types.ts              # TypeScript types
    state.ts              # Jotai atoms for shared state
    db.ts                 # Database operations
    panel/
      SQLitePanel.tsx     # Main panel component
      ConnectionsList.tsx # Connections view
      SchemaView.tsx      # Schema tree view
      QueryView.tsx       # Query editor
    settings/
      SQLiteSettings.tsx  # Settings panel
    tools/
      index.ts            # AI tool definitions
    components/
      ResultsTable.tsx    # Query results display
    styles.css            # Panel styles
```

## Best Practices

1. **Use Jotai for shared state** - Enables AI tools and UI to share state cleanly

2. **Update AI context proactively** - Call `host.ai.setContext()` when relevant state changes

3. **Handle missing connections gracefully** - AI tools should return helpful errors when panel isn't configured

4. **Support themes** - Use CSS variables that respond to `data-theme` attribute

5. **Keep panel state persistent** - Use workspace storage for view state, global for configuration

6. **Namespace your AI tools** - Use `extension.action` format (e.g., `sqlite.query`)
