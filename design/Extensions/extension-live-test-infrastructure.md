# Extension Live Test Infrastructure

## Problem

Nimbalyst has a unique AI-driven extension development loop: the agent writes code, builds, installs, hot-reloads, reads logs, and captures screenshots -- all without leaving the conversation. But the loop has a gap: there's no way to **interact with** or **assert against** a running extension programmatically.

Today the agent can see the extension (screenshot) and read errors (logs), but it can't:
- Click buttons, type into inputs, or simulate user interactions
- Assert that specific elements exist, are visible, or contain expected text
- Run a repeatable test suite to catch regressions after changes
- Verify that AI tools return expected results for given inputs

This means the agent's "testing" is limited to visual inspection and log scanning -- it can't close the loop the way a human developer running the app can.

## Goals

1. **Agent writes real Playwright scripts** -- full API, real selectors, real assertions, no bespoke action language
2. **Tests run against the live running Nimbalyst instance** via CDP -- no separate Electron launch
3. **Extensions can interact with the rest of Nimbalyst** -- tests are NOT scoped/sandboxed to the extension's DOM only
4. **Tests can be ephemeral (agent runs and discards) or persistent (saved in extension project)**
5. **Works with the existing reload loop** -- after `extension_reload`, the agent can immediately run tests

## Non-Goals

- Replacing the existing E2E test suite (which launches fresh Electron instances for clean state)
- Unit testing extension code in isolation (vitest handles that)
- A human-facing test UI or test explorer panel (the Playwright extension already does this for E2E tests)
- Running tests against packaged builds (dev mode only)

## Design

### How It Works: Playwright + CDP

Playwright can connect to an already-running Electron app via Chrome DevTools Protocol (CDP). This is a single connection to the existing process -- no second Electron instance, no database lock contention, no state duplication.

```
Agent (Claude Code)
  |
  | MCP tool call: extension_test_run({ script: "..." })
  v
Main Process (extensionDevServer.ts)
  |
  | Spawns: npx playwright test <tempfile> --config <extension-test-config>
  v
Playwright (Node.js subprocess)
  |
  | connectOverCDP("http://localhost:9222")
  v
Running Nimbalyst Renderer (same instance the user sees)
  |
  | Full browser automation: click, type, assert, screenshot, evaluate
  v
Extension's live DOM + rest of Nimbalyst
```

**Key insight:** This is ONE Nimbalyst process. Playwright connects to it as a remote client, like DevTools. The agent tests the exact same app state the user is looking at.

### Enabling CDP in Dev Mode

Electron needs to be started with `--remote-debugging-port` to expose CDP. This is a one-line change to the dev configuration:

```typescript
// In electron.vite.config.ts or crystal-run.sh, dev mode only:
// Add to Electron launch args:
app.commandLine.appendSwitch('remote-debugging-port', '9222');
```

Only enabled in dev mode. The port is deterministic so the Playwright config can hard-code it.

### The MCP Tool

One primary tool: `extension_test_run`. The agent writes Playwright code, the tool executes it.

```typescript
{
  name: "extension_test_run",
  inputSchema: {
    // Option A: inline script (agent writes code directly)
    script?: string,
    // Option B: run a test file from the extension project
    testFile?: string,
    // Context
    extensionId?: string,      // for logging/scoping helpers
    timeout?: number,          // max execution time (default: 30000ms)
  }
}

// Returns:
{
  passed: boolean,
  output: string,              // Playwright's stdout (test results)
  errors?: string[],           // failure messages
  duration: number,            // ms
  screenshots?: Array<{        // any screenshots taken during the test
    name: string,
    base64: string,
  }>,
}
```

#### Inline Script Mode

The agent writes a Playwright script directly. The tool wraps it in a test harness:

```typescript
// Agent writes this:
const script = `
  const editor = page.locator('[data-extension-id="com.nimbalyst.kanban"]');

  // Add a new card
  await editor.locator('.add-card-btn').click();
  await editor.locator('.card-title-input').fill('Test task');
  await editor.locator('.card-title-input').press('Enter');

  // Verify it was added
  await expect(editor.locator('.card')).toHaveCount(1);
  await expect(editor.locator('.card-title')).toHaveText('Test task');

  // Verify it persists in the DOM after a reload
  // (agent would call extension_reload before re-running)
`;
```

The tool wraps this into a full test file:

```typescript
// Generated wrapper (tempfile):
import { test, expect } from '@playwright/test';

test('extension test', async ({ page }) => {
  // page is already connected to running Nimbalyst via CDP
  ${script}
});
```

#### Test File Mode

The agent writes a proper `.spec.ts` file in the extension project and passes the path:

```typescript
// extensions/my-extension/tests/kanban.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Kanban Extension', () => {
  test('adds a card', async ({ page }) => {
    const board = page.locator('[data-extension-id="com.nimbalyst.kanban"]');
    await board.locator('.add-card-btn').click();
    await board.locator('.card-title-input').fill('Test task');
    await board.locator('.card-title-input').press('Enter');
    await expect(board.locator('.card')).toHaveCount(1);
  });

  test('drags card between columns', async ({ page }) => {
    const board = page.locator('[data-extension-id="com.nimbalyst.kanban"]');
    const card = board.locator('.card').first();
    const target = board.locator('.column[data-status="done"]');
    await card.dragTo(target);
    await expect(target.locator('.card')).toHaveCount(1);
  });
});
```

The agent runs it with:
```
extension_test_run({ testFile: "/path/to/extensions/my-extension/tests/kanban.spec.ts" })
```

### Playwright Configuration for Extension Tests

A dedicated Playwright config that connects to the running instance instead of launching one:

```typescript
// packages/electron/playwright-extension.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', // dynamic -- tool passes the actual test file
  timeout: 30000,
  retries: 0,   // no retries -- agent handles failures directly
  reporter: [['json', { outputFile: '/tmp/nimbalyst-ext-test-results.json' }]],

  use: {
    // Connect to the running Nimbalyst instance via CDP
    connectOptions: {
      wsEndpoint: 'http://localhost:9222',
    },
  },

  // Single worker -- we're talking to one app instance
  workers: 1,
  fullyParallel: false,
});
```

**Note on CDP + Electron:** Playwright's `connectOverCDP` returns a `Browser` object. From there we get the existing `BrowserContext` and the already-open `Page` (the Nimbalyst renderer window). The test receives this `page` directly -- no navigation needed.

A custom fixture handles the connection:

```typescript
// packages/electron/e2e/extension-test-fixture.ts
import { test as base, expect } from '@playwright/test';
import { chromium } from 'playwright';

export const test = base.extend({
  page: async ({}, use) => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const contexts = browser.contexts();
    const page = contexts[0]?.pages()[0];
    if (!page) throw new Error('No Nimbalyst window found via CDP');
    await use(page);
    // Don't close -- it's the user's running app
  },
});

export { expect };
```

Extensions import from this fixture instead of `@playwright/test`:

```typescript
// In extension test files:
import { test, expect } from '@nimbalyst/extension-test-fixture';
// (or the tool auto-wraps inline scripts with the right imports)
```

### What the Agent Gets: Full Playwright API

Because these are real Playwright tests, the agent has access to everything:

**Locators and Selectors:**
```typescript
page.locator('.card-title')           // CSS
page.getByRole('button', { name: 'Save' })  // Accessibility
page.getByText('No items')           // Text content
page.getByTestId('kanban-column')    // data-testid
```

**Assertions:**
```typescript
await expect(locator).toBeVisible();
await expect(locator).toHaveText('Expected');
await expect(locator).toHaveCount(3);
await expect(locator).toHaveCSS('color', 'rgb(255, 0, 0)');
await expect(locator).toBeEnabled();
```

**Interactions:**
```typescript
await locator.click();
await locator.fill('text');
await locator.press('Enter');
await locator.dragTo(target);
await locator.selectOption('value');
await page.keyboard.press('Control+z');  // undo
```

**Screenshots:**
```typescript
await page.screenshot({ path: 'test.png' });
await locator.screenshot({ path: 'component.png' });
```

**Evaluate (escape hatch into renderer):**
```typescript
// Access extension internals, Nimbalyst APIs, etc.
const state = await page.evaluate(() => {
  return document.querySelector('[data-extension-id="com.nimbalyst.kanban"]')
    .__reactFiber$.memoizedState;  // inspect React state
});
```

**Wait patterns:**
```typescript
await page.waitForSelector('.loading-spinner', { state: 'hidden' });
await expect(locator).toBeVisible({ timeout: 5000 });
await page.waitForResponse(resp => resp.url().includes('/api/data'));
```

No bespoke action language. No reinvented assertions. The agent writes Playwright.

### Testing AI Tools

Extensions expose AI tools via MCP. The agent can test these two ways:

#### 1. Via Playwright (end-to-end)

The agent can use `page.evaluate()` to call extension tool handlers directly in the renderer:

```typescript
const result = await page.evaluate(async () => {
  // Access the extension's tool bridge
  const bridge = window.__nimbalyst_extension_tools__;
  return await bridge.executeExtensionTool('excalidraw.get_elements', {});
});
expect(result.success).toBe(true);
expect(result.data.elements).toHaveLength(3);
```

#### 2. Via dedicated MCP tool (shortcut)

For convenience, keep a simple `extension_test_ai_tool` MCP tool that bypasses Playwright for pure tool-handler testing:

```typescript
{
  name: "extension_test_ai_tool",
  inputSchema: {
    extensionId: string,
    toolName: string,            // e.g., "get_elements"
    args?: Record<string, unknown>,
    filePath?: string,
  }
}
// Returns the raw ExtensionToolResult
```

This is faster for testing tool logic without browser automation overhead. The agent uses it to verify tool handlers return correct data, then uses Playwright scripts to test the full UI flow.

### Opening Files for Testing

Extensions need files open to test against. A helper tool:

```typescript
{
  name: "extension_test_open_file",
  inputSchema: {
    filePath: string,            // absolute path to the file to open
    waitForExtension?: string,   // wait until this extension's editor renders
    timeout?: number,            // max wait time (default: 5000ms)
  }
}
// Returns:
{
  opened: boolean,
  extensionId?: string,          // which extension handled the file
  error?: string,
}
```

This opens the file in Nimbalyst (creating a tab), waits for the extension editor to mount, and returns. The agent then runs Playwright scripts against it.

### Visual Regression via Playwright

Playwright has built-in screenshot comparison (`toHaveScreenshot`). The agent can use this directly:

```typescript
test('kanban board visual regression', async ({ page }) => {
  const board = page.locator('[data-extension-id="com.nimbalyst.kanban"]');
  await expect(board).toHaveScreenshot('kanban-initial.png', {
    maxDiffPixelRatio: 0.01,
  });

  // Make a change
  await board.locator('.add-card-btn').click();
  await board.locator('.card-title-input').fill('New card');
  await board.locator('.card-title-input').press('Enter');

  await expect(board).toHaveScreenshot('kanban-after-add.png', {
    maxDiffPixelRatio: 0.01,
  });
});
```

Baseline images stored alongside test files in the extension project. Playwright handles comparison, diff image generation, and threshold logic. No need to build our own.

### Integration with the Development Loop

The complete agent loop becomes:

```
1. Write/edit extension code
2. extension_reload              --> build errors? fix and retry
3. extension_get_status          --> loaded? contributions correct?
4. extension_test_open_file      --> open a test file in the extension editor
5. extension_test_run({ script }) --> Playwright tests against live app
   |
   +-- failures? read errors, fix code, go to step 2
   |
   +-- want to save tests? write to extension's tests/ folder
6. capture_editor_screenshot     --> visual check (agent sees inline)
7. get_renderer_debug_logs       --> runtime errors?
   |
   +-- issues? go to step 1
   |
   +-- all good? done
```

The agent can also write persistent test files during development:

```
1. Agent creates extensions/my-extension/tests/basics.spec.ts
2. extension_test_run({ testFile: ".../tests/basics.spec.ts" })
3. Tests pass -- file stays in the project
4. Agent makes code changes, runs tests again
5. Regression caught -- agent fixes and re-runs
6. Tests become part of the extension's deliverable
```

### Data Attributes Contract

For Playwright selectors to work reliably, the extension rendering infrastructure should set stable attributes:

| Context | Container | Attributes |
|---------|-----------|-----------|
| Custom editor | Editor wrapper div | `data-extension-id`, `data-file-path` |
| Panel | Panel content div | `data-extension-id`, `data-panel="<panelId>"` |
| Document header | Header wrapper | `data-extension-id`, `data-header="<headerId>"` |

These are set by the host infrastructure (TabEditor, PanelRenderer), not by extensions themselves. Extensions don't need to know about them. They make it easy to scope Playwright locators:

```typescript
// Target a specific extension's editor for a specific file
page.locator('[data-extension-id="com.nimbalyst.csv"][data-file-path="/path/to/data.csv"]')
```

But critically, the agent is NOT limited to these selectors. It can interact with any part of Nimbalyst -- the sidebar, the AI panel, other tabs, menus, etc. The data attributes are convenience, not a boundary.

## Implementation Plan

### Phase 1: CDP + Script Runner

1. **Enable CDP in dev mode** -- Add `--remote-debugging-port=9222` to Electron launch in dev mode only. Gate behind `NIMBALYST_DEV` or similar env var.
2. **Create extension test fixture** -- `extension-test-fixture.ts` that `connectOverCDP` and provides the existing page. Publish as part of `@nimbalyst/extension-sdk` or a separate `@nimbalyst/extension-testing` package.
3. **Create Playwright config for extension tests** -- `playwright-extension.config.ts` with CDP connection, JSON reporter, single worker.
4. **Implement `extension_test_run` MCP tool** -- Accepts inline script or test file path. Writes temp file if inline, spawns `npx playwright test` with extension config, parses JSON results, returns structured output.
5. **Implement `extension_test_open_file` MCP tool** -- Opens a file via IPC, waits for extension editor mount, returns.

### Phase 2: Data Attributes + Convenience

6. **Add `data-extension-id` and `data-file-path`** to custom editor containers in TabEditor.
7. **Add `data-extension-id` and `data-panel`** to panel containers.
8. **Implement `extension_test_ai_tool`** MCP tool for direct tool handler testing.
9. **Expose `__nimbalyst_extension_tools__`** on window in dev mode for `page.evaluate()` access.

### Phase 3: Extension SDK Integration

10. **Add testing utilities to `@nimbalyst/extension-sdk`** -- Re-export the fixture, provide helper locators (e.g., `extensionLocator(page, extensionId, filePath?)`), document patterns.
11. **Add test scaffold to `new-extension` template** -- Include a sample `.spec.ts` and `playwright.config.ts` in scaffolded extensions.
12. **Document the testing workflow** in EXTENSION_ARCHITECTURE.md.

### Phase 4: Agent Skill

13. **Create a Claude plugin skill** for extension test authoring -- teaches the agent the patterns, fixture imports, and common assertion strategies.
14. **Update the extension-development skill** to include the test loop in the recommended workflow.

## Open Questions

1. **CDP port conflicts:** If the user is running multiple dev instances (user2, worktree), each needs a different CDP port. Should we auto-discover the port, or use a known offset (9222 for primary, 9223 for user2, etc.)?

2. **Test state management:** Tests run against live app state. If a test creates files or modifies data, that persists. Should the tool support a "clean up after" mechanism, or is that the agent's responsibility?

3. **Playwright dependency:** Playwright is already a devDependency for E2E tests. Extension projects would need it too, or we bundle the test runner so extensions don't need their own Playwright install. What's cleaner?

4. **Timeout on inline scripts:** Inline scripts run as a single Playwright test. If the agent writes a long script with many assertions, should we chunk it or just set a generous timeout?

## Comparison with VS Code Extension Testing

| Capability | VS Code | Nimbalyst (proposed) |
|---|---|---|
| Test framework | `@vscode/test-electron` (launches separate instance) | Playwright via CDP (connects to running instance) |
| API | Custom test API, limited DOM access | Full Playwright API |
| DOM interaction | Not possible (extensions in separate process) | Full browser automation |
| Visual regression | Not built-in | Playwright `toHaveScreenshot` |
| AI tool testing | N/A | `extension_test_ai_tool` + `page.evaluate()` |
| Agent-driven loop | Not feasible | MCP tool, agent writes and runs Playwright scripts in conversation |
| Test execution overhead | ~5-10s (Electron launch) | ~1-2s (CDP connect, no launch) |
| Scope | Extension host process only | Full app -- extension + Nimbalyst UI together |
| Persistent tests | Yes (standard test files) | Yes (same -- .spec.ts files in extension project) |
| Ephemeral tests | No | Yes (inline scripts, agent iterates without saving) |

The fundamental difference: VS Code tests launch an isolated sandbox. Nimbalyst tests drive the real app. Extensions can test their integration with the full Nimbalyst experience -- file tree, AI panel, tabs, menus, other extensions -- because Playwright sees everything.
