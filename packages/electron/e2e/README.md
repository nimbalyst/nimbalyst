# E2E Test Suite

## Directory Structure

- **`core/`** - Critical smoke tests (app launch, files, editing, saving)
- **`tabs/`** - Tab management (autosave, reordering, switching)
- **`ai/`** - AI provider integration (Claude Code CLI)
- **`backup/`** - Old test backups

## Test Helpers (`helpers.ts`)

Central configuration and utilities:

- **`TEST_TIMEOUTS`** - Centralized timeout values
  - `APP_LAUNCH: 5000ms` - App startup
  - `SIDEBAR_LOAD: 5000ms` - Sidebar appearance
  - `FILE_TREE_LOAD: 5000ms` - File tree items
  - `TAB_SWITCH: 3000ms` - Tab switching
  - `EDITOR_LOAD: 3000ms` - Editor loading
  - `SAVE_OPERATION: 2000ms` - File saves
  - `DEFAULT_WAIT: 500ms` - General waits

- **`launchElectronApp(options)`** - Launch app with workspace
- **`createTempWorkspace()`** - Create temp test workspace
- **`waitForAppReady(page)`** - Wait for app to fully load
- **`waitForEditor(page)`** - Wait for editor component
- **`getKeyboardShortcut(key)`** - Cross-platform shortcuts

## Running Tests

```bash
# Run all e2e tests
npm run test:e2e

# Run specific test file
npm run test:e2e core/app-startup.spec.ts

# Run specific directory
npm run test:e2e tabs/

# Run with UI
npm run test:e2e:ui
```

## Test Rules

1. **Never remove failing tests** - Fix them
2. **Never skip/disable tests** - Fix the underlying issue
3. **Use centralized timeouts** - Import from `TEST_TIMEOUTS`
4. **Core tests must pass** - These protect basic functionality
5. **AI tests may fail** - External dependencies (skip if unavailable)