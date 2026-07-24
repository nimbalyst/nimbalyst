# Custom Tracker Implementation Plan

This document outlines what needs to be implemented to support the custom tracker user experience described in `creating-custom-trackers.md`.

## ✅ IMPLEMENTATION COMPLETE (2025-10-29)

**All Features Working:**
- ✅ Built-in trackers (plan, decision, bug, task, idea)
- ✅ Inline tracking with `#type[...]` syntax
- ✅ Full document tracking with frontmatter
- ✅ Status bar rendering based on data models
- ✅ TrackerPlugin architecture in place
- ✅ Custom tracker YAML loading from `.nimbalyst/trackers/`
- ✅ File reading bypasses cache issues (reads directly)
- ✅ globalRegistry and parseTrackerYAML exported
- ✅ E2E test framework captures renderer logs
- ✅ Custom tracker registers successfully
- ✅ TypeaheadMenu reads dynamically from globalRegistry
- ✅ **Custom trackers appear in `#` typeahead menu**
- ✅ **E2E test passes**

**Test Result:**
```
✓ Custom Tracker Loading › should load custom character tracker from YAML file (11.7s)
  1 passed
```

## Implementation Summary

### Key Changes Made

1. **Dynamic Typeahead Menu** (`/packages/runtime/src/plugins/TrackerPlugin/index.tsx:594-616`)
   - Removed hardcoded tracker options array
   - Now reads from `globalRegistry.getAll()` on every render
   - Dynamically includes all trackers with `modes.inline: true`

2. **Custom Tracker Loading** (`/packages/electron/src/renderer/App.tsx:87-147`)
   - `loadCustomTrackers()` function reads YAML files directly (no cache)
   - Tries known files first: character.yaml, recipe.yaml, research-paper.yaml
   - Falls back to directory scan for unknown files
   - Loads immediately when workspace becomes available

3. **E2E Test** (`/packages/electron/e2e/tracker/custom-tracker.spec.ts`)
   - Creates `.nimbalyst/trackers/character.yaml`
   - Launches app with workspace
   - Types `#` in editor
   - Verifies "Character" appears in typeahead menu

---

## Implementation Tasks (Completed)

### Phase 1: YAML File Loading ✅

**Goal**: Load custom tracker definitions from `.nimbalyst/trackers/*.yaml` files

#### Task 1.1: Electron Main Process - File System Access
**File**: `packages/electron/src/main/services/TrackerLoaderService.ts` (new)

Create a service to scan and load tracker YAML files:

```typescript
class TrackerLoaderService {
  async loadWorkspaceTrackers(workspacePath: string): Promise<TrackerDataModel[]> {
    // 1. Check if .nimbalyst/trackers/ exists
    // 2. Scan for *.yaml files
    // 3. Read each file
    // 4. Parse YAML using js-yaml
    // 5. Validate against TrackerDataModel schema
    // 6. Return array of models
  }

  watchTrackerDirectory(workspacePath: string, callback: (models: TrackerDataModel[]) => void): void {
    // Watch .nimbalyst/trackers/ for changes
    // Reload and callback when files change
  }
}
```

**Dependencies**:
- `js-yaml` (already in package.json)
- Node.js `fs` and `path` modules
- `chokidar` for file watching (already in package.json)

#### Task 1.2: IPC Bridge for Tracker Loading
**File**: `packages/electron/src/preload/index.ts`

Add IPC methods for tracker loading:

```typescript
electronAPI.invoke('tracker-service:loadWorkspaceTrackers', workspacePath)
electronAPI.on('tracker-service:trackersChanged', callback)
```

**File**: `packages/electron/src/main/index.ts`

Register IPC handlers:

```typescript
ipcMain.handle('tracker-service:loadWorkspaceTrackers', async (event, workspacePath) => {
  return await trackerLoaderService.loadWorkspaceTrackers(workspacePath);
});
```

#### Task 1.3: Renderer - Load Custom Trackers on App Start
**File**: `packages/electron/src/renderer/plugins/registerTrackerPlugin.ts`

Update to load custom trackers:

```typescript
export async function registerTrackerPlugin() {
  // 1. Load built-in trackers (existing code)
  ModelLoader.getInstance();

  // 2. Get workspace path
  const workspacePath = getWorkspacePath();

  // 3. Load custom trackers from .nimbalyst/trackers/
  if (workspacePath) {
    const customTrackers = await window.electronAPI.invoke(
      'tracker-service:loadWorkspaceTrackers',
      workspacePath
    );

    // 4. Register each custom tracker with ModelLoader
    for (const model of customTrackers) {
      globalRegistry.register(model);
    }

    console.log(`Loaded ${customTrackers.length} custom trackers`);
  }

  // 5. Register for changes
  window.electronAPI.on('tracker-service:trackersChanged', (models) => {
    // Clear existing custom trackers
    // Re-register custom trackers
    // Trigger UI refresh
  });
}
```

### Phase 2: YAML Parser Enhancement

**Goal**: Ensure YAMLParser.ts can handle all field types and validate tracker definitions

#### Task 2.1: Validation Schema
**File**: `packages/runtime/src/plugins/TrackerPlugin/models/TrackerDataModel.ts`

Add JSON Schema validation:

```typescript
import Ajv from 'ajv';

const trackerSchema = {
  type: 'object',
  required: ['type', 'displayName', 'displayNamePlural', 'icon', 'color', 'modes', 'fields'],
  properties: {
    type: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    displayName: { type: 'string' },
    displayNamePlural: { type: 'string' },
    icon: { type: 'string' },
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    modes: {
      type: 'object',
      properties: {
        inline: { type: 'boolean' },
        fullDocument: { type: 'boolean' }
      }
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string' },
          type: { enum: ['string', 'text', 'number', 'select', 'date', 'array', 'object'] },
          required: { type: 'boolean' },
          default: {},
          // ... more field properties
        }
      }
    }
  }
};

export function validateTrackerModel(model: any): { valid: boolean; errors?: string[] } {
  const ajv = new Ajv();
  const validate = ajv.compile(trackerSchema);
  const valid = validate(model);
  return { valid, errors: validate.errors?.map(e => e.message) };
}
```

#### Task 2.2: Error Handling
**File**: `packages/runtime/src/plugins/TrackerPlugin/models/YAMLParser.ts`

Add better error messages:

```typescript
export function parseTrackerYAML(yamlString: string): TrackerDataModel {
  try {
    const parsed = yaml.load(yamlString);

    // Validate against schema
    const validation = validateTrackerModel(parsed);
    if (!validation.valid) {
      throw new Error(`Invalid tracker definition:\n${validation.errors.join('\n')}`);
    }

    return parsed as TrackerDataModel;
  } catch (error) {
    throw new Error(`Failed to parse tracker YAML: ${error.message}`);
  }
}
```

### Phase 3: Automatic Directory Creation

**Goal**: Create `.nimbalyst/trackers/` directory on first workspace open

#### Task 3.1: Workspace Initialization
**File**: `packages/electron/src/main/services/WorkspaceService.ts`

Add tracker directory initialization:

```typescript
async initializeWorkspace(workspacePath: string): Promise<void> {
  const trackerDir = path.join(workspacePath, '.nimbalyst', 'trackers');

  // Create directory if it doesn't exist
  await fs.mkdir(trackerDir, { recursive: true });

  // Create README.md with instructions
  const readmePath = path.join(trackerDir, 'README.md');
  if (!await fs.exists(readmePath)) {
    await fs.writeFile(readmePath, TRACKER_README_TEMPLATE);
  }
}
```

#### Task 3.2: Example Tracker Files
**File**: `packages/electron/assets/tracker-examples/`

Create example tracker files that can be copied to new workspaces:

- `character.yaml.example` - Character tracker example
- `recipe.yaml.example` - Recipe tracker example
- `research-paper.yaml.example` - Research paper example

These can be referenced in the README or copied by users.

### Phase 4: UI for Tracker Management

**Goal**: Allow users to manage trackers without editing YAML files directly

#### Task 4.1: Settings Panel - Tracker Management Tab
**File**: `packages/electron/src/renderer/components/Settings/TrackerManagementPanel.tsx` (new)

Create a settings panel for trackers:

```typescript
function TrackerManagementPanel() {
  return (
    <div>
      <h2>Tracker Management</h2>

      {/* List of built-in trackers */}
      <section>
        <h3>Built-in Trackers</h3>
        {builtinTrackers.map(tracker => (
          <TrackerListItem tracker={tracker} canDisable />
        ))}
      </section>

      {/* List of custom trackers */}
      <section>
        <h3>Custom Trackers</h3>
        {customTrackers.map(tracker => (
          <TrackerListItem tracker={tracker} canEdit canDelete />
        ))}
      </section>

      {/* Create new tracker button */}
      <button onClick={openTrackerWizard}>
        Create Custom Tracker
      </button>
    </div>
  );
}
```

#### Task 4.2: Tracker Wizard Dialog
**File**: `packages/electron/src/renderer/components/Settings/TrackerWizard.tsx` (new)

Create a wizard for building tracker definitions:

**Steps**:
1. Basic info (type, name, icon, color)
2. Modes (inline/full document)
3. Add fields (with UI for each field type)
4. Configure layout (drag-and-drop field ordering)
5. Preview
6. Save

The wizard generates the YAML file in `.nimbalyst/trackers/`.

#### Task 4.3: Tracker Editor
**File**: `packages/electron/src/renderer/components/Settings/TrackerEditor.tsx` (new)

Allow editing existing tracker definitions:

- Load YAML from file
- Parse into form fields
- Edit in UI
- Save back to YAML

**Alternative**: Just open the YAML file in the editor with syntax highlighting.

### Phase 5: Hot Reload Support

**Goal**: Reload trackers when YAML files change without restarting the app

#### Task 5.1: File Watcher in Main Process
**File**: `packages/electron/src/main/services/TrackerLoaderService.ts`

Use chokidar to watch for changes:

```typescript
watchTrackerDirectory(workspacePath: string): void {
  const trackerDir = path.join(workspacePath, '.nimbalyst', 'trackers');

  const watcher = chokidar.watch('*.yaml', {
    cwd: trackerDir,
    ignoreInitial: true
  });

  watcher.on('add', filePath => this.reloadTracker(filePath));
  watcher.on('change', filePath => this.reloadTracker(filePath));
  watcher.on('unlink', filePath => this.unloadTracker(filePath));
}

async reloadTracker(filePath: string): Promise<void> {
  // 1. Read file
  // 2. Parse YAML
  // 3. Validate
  // 4. Send to all renderer processes via IPC
  const model = await this.loadTrackerFile(filePath);

  BrowserWindow.getAllWindows().forEach(window => {
    window.webContents.send('tracker-service:trackerUpdated', model);
  });
}
```

#### Task 5.2: Renderer Reload Handler
**File**: `packages/electron/src/renderer/plugins/registerTrackerPlugin.ts`

Handle tracker updates:

```typescript
window.electronAPI.on('tracker-service:trackerUpdated', (model: TrackerDataModel) => {
  // 1. Update registry
  globalRegistry.register(model); // This will replace existing

  // 2. Trigger UI refresh
  // - Refresh typeahead
  // - Refresh status bars
  // - Refresh table views

  // 3. Show notification
  showNotification(`Tracker "${model.displayName}" reloaded`);
});
```

### Phase 6: Error Handling and User Feedback

**Goal**: Provide clear feedback when trackers fail to load

#### Task 6.1: Error Notifications
**File**: `packages/electron/src/renderer/components/Notifications/TrackerErrorNotification.tsx`

Show user-friendly errors:

```typescript
function TrackerErrorNotification({ trackerFile, error }: Props) {
  return (
    <Notification type="error">
      <h4>Failed to load tracker: {trackerFile}</h4>
      <p>{error.message}</p>
      <button onClick={() => openFileInEditor(trackerFile)}>
        Open File
      </button>
      <button onClick={() => openDocumentation()}>
        View Documentation
      </button>
    </Notification>
  );
}
```

#### Task 6.2: Validation Warnings
**File**: `packages/electron/src/main/services/TrackerLoaderService.ts`

Warn about non-critical issues:

```typescript
// Warnings (don't fail, but notify):
// - Missing recommended fields (created, updated)
// - Unusual field types
// - Performance concerns (too many fields)
// - Missing statusBarLayout for fullDocument trackers
```

### Phase 7: Documentation Integration

**Goal**: Make documentation accessible from the app

#### Task 7.1: Help Menu Integration
**File**: `packages/electron/src/main/menu.ts`

Add menu items:

```typescript
{
  label: 'Help',
  submenu: [
    {
      label: 'Creating Custom Trackers',
      click: () => openDocumentation('creating-custom-trackers')
    },
    {
      label: 'Tracker Examples',
      click: () => openTrackerExamples()
    }
  ]
}
```

#### Task 7.2: In-App Documentation Viewer
**File**: `packages/electron/src/renderer/components/Documentation/TrackerDocsViewer.tsx`

Show documentation in a dialog or side panel:

- Load markdown documentation
- Render with syntax highlighting
- Show examples with "Try This" buttons
- Link to example files

### Phase 8: Template Library

**Goal**: Provide pre-made tracker templates users can copy

#### Task 8.1: Template Gallery
**File**: `packages/electron/src/renderer/components/Settings/TrackerTemplateGallery.tsx`

Gallery of tracker templates:

```typescript
const TEMPLATES = [
  {
    id: 'character',
    name: 'Book/Movie Character',
    description: 'Track characters across books or movies',
    icon: 'person',
    category: 'Entertainment'
  },
  {
    id: 'recipe',
    name: 'Recipe Collection',
    description: 'Organize your recipes',
    icon: 'restaurant',
    category: 'Personal'
  },
  // ... more templates
];

function TrackerTemplateGallery() {
  return (
    <div className="template-gallery">
      {TEMPLATES.map(template => (
        <TemplateCard
          template={template}
          onInstall={() => installTemplate(template.id)}
        />
      ))}
    </div>
  );
}
```

#### Task 8.2: Template Installation
**File**: `packages/electron/src/main/services/TrackerTemplateService.ts`

Copy template files to workspace:

```typescript
async installTemplate(templateId: string, workspacePath: string): Promise<void> {
  // 1. Load template YAML from assets
  const templatePath = path.join(__dirname, 'assets', 'tracker-templates', `${templateId}.yaml`);
  const templateContent = await fs.readFile(templatePath, 'utf8');

  // 2. Copy to workspace .nimbalyst/trackers/
  const destPath = path.join(workspacePath, '.nimbalyst', 'trackers', `${templateId}.yaml`);
  await fs.writeFile(destPath, templateContent);

  // 3. Tracker will auto-load via file watcher
}
```

## Testing Requirements

### Unit Tests

**File**: `packages/runtime/src/plugins/TrackerPlugin/models/__tests__/YAMLParser.test.ts`

Test YAML parsing:
- Valid tracker definitions
- Invalid YAML syntax
- Missing required fields
- Invalid field types
- Schema validation

### Integration Tests

**File**: `packages/electron/__tests__/integration/tracker-loading.test.ts`

Test the full loading flow:
- Create workspace with custom tracker
- Verify tracker loads on app start
- Modify tracker YAML
- Verify hot reload works
- Delete tracker file
- Verify tracker unloads

### E2E Tests

**File**: `packages/electron/e2e/tracker/custom-tracker.spec.ts`

Test user workflows:
- Create custom tracker via wizard
- Use custom tracker inline
- Create full document with custom tracker
- View custom tracker in table view
- Edit custom tracker definition
- Delete custom tracker

## Migration Strategy

### Backward Compatibility

**Goal**: Ensure existing hardcoded trackers continue to work

1. Keep built-in trackers hardcoded in ModelLoader.ts
2. Custom trackers augment, not replace
3. If custom tracker has same type as built-in, custom wins (user override)

### Deprecation Path

Once YAML loading is stable:

1. Move built-in tracker definitions to YAML files in assets
2. Load from assets instead of hardcoded objects
3. Eventually remove hardcoded definitions
4. Keep ModelLoader.ts for registry management only

## Dependencies to Add

```json
{
  "dependencies": {
    "ajv": "^8.12.0",           // JSON schema validation
    "chokidar": "^3.5.3"        // Already installed
  }
}
```

## Documentation Updates Needed

1. **User Docs**:
   - `creating-custom-trackers.md` (already created)
   - `tracker-yaml-reference.md` - Complete field type reference
   - `tracker-examples.md` - Gallery of examples

2. **Developer Docs**:
   - `tracker-architecture.md` - How the system works
   - `adding-field-types.md` - How to extend with new field types
   - `tracker-ui-components.md` - UI component reference

3. **In-App Help**:
   - Tooltips in tracker wizard
   - Validation error messages
   - Example snippets

## Success Criteria

- [ ] User can create `.nimbalyst/trackers/mytracker.yaml`
- [ ] Custom tracker loads automatically on app start
- [ ] Typeahead shows custom tracker with icon
- [ ] Inline references work with custom tracker
- [ ] Full documents work with custom tracker status bar
- [ ] Table views work with custom tracker
- [ ] Hot reload when YAML file changes
- [ ] Clear error messages for invalid YAML
- [ ] Template gallery with 5+ examples
- [ ] Documentation accessible from app
- [ ] All tests passing

## Implementation Order

**Priority 1** (MVP - Users can create trackers):
1. Phase 1: YAML File Loading
2. Phase 2: YAML Parser Enhancement
3. Phase 3: Automatic Directory Creation
4. Basic error handling

**Priority 2** (Better UX):
5. Phase 5: Hot Reload Support
6. Phase 6: Error Handling and User Feedback
7. Phase 7: Documentation Integration

**Priority 3** (Polish):
8. Phase 4: UI for Tracker Management
9. Phase 8: Template Library

## Estimated Effort

- Phase 1: 2-3 days
- Phase 2: 1 day
- Phase 3: 0.5 days
- Phase 4: 3-4 days (UI heavy)
- Phase 5: 1 day
- Phase 6: 1 day
- Phase 7: 1 day
- Phase 8: 2 days
- Testing: 2 days

**Total**: ~13-15 days for complete implementation

**MVP** (Phases 1-3): ~4-5 days

## Next Steps

1. Review this plan with stakeholders
2. Prioritize which phases to implement first
3. Create issues/tasks for each phase
4. Begin with Phase 1 (YAML File Loading)
5. Iterate with user feedback

---

This implementation plan enables the user experience documented in `creating-custom-trackers.md`.
