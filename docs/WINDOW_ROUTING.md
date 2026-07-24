# Window Routing and State Management

This document explains how to correctly route operations to windows in Nimbalyst's Electron application.

## Core Concepts

### Window Identifiers: Stable vs Transient

**Stable Identifiers (Preferred):**
- **Workspace Path** (`workspacePath`): The absolute path to a workspace directory
  - Remains constant across window close/reopen
  - Sessions are tied to workspaces, not windows
  - Example: `/Users/john/projects/my-app`

**Transient Identifiers (Use Carefully):**
- **Electron Window ID** (`BrowserWindow.id`, `event.sender.id`): Numeric ID assigned by Electron
  - Changes every time a window is closed and reopened
  - Only valid for the lifetime of a specific window instance
  - Example: Window opens with ID 42, closes, reopens with ID 57

## When to Use Each Approach

### Use Workspace Path Routing

For **async/deferred operations** that may happen after the original window closes:

```typescript
// ✅ CORRECT: OS notifications (user clicks later)
notificationService.showNotification({
  title: 'AI Response Ready',
  workspacePath: session.workspacePath,  // Stable routing
  sessionId: session.id
});

// ✅ CORRECT: Sound notifications
soundService.playCompletionSound(event.sender.id, workspacePath);

// ✅ CORRECT: Any background/scheduled operations
const { findWindowByWorkspace } = require('./window/WindowManager');
const targetWindow = findWindowByWorkspace(workspacePath);
```

### Use event.sender

For **immediate IPC responses** during the same call:

```typescript
// ✅ CORRECT: Streaming responses back to requesting window
ipcMain.handle('ai:sendMessage', async (event, message) => {
  // Stream chunks back to the window that made this request
  event.sender.send('ai:streamResponse', { chunk });

  // Send errors back to requesting window
  event.sender.send('ai:error', { error });

  return result;
});
```

## The Routing Pattern

### No Fallbacks - Fail Fast

**DO NOT implement fallback strategies.** They mask bugs and create unpredictable behavior.

```typescript
// ✅ CORRECT: Require workspace path, fail if missing
if (!workspacePath) {
  throw new Error('workspacePath is required for routing');
}

const targetWindow = findWindowByWorkspace(workspacePath);

if (!targetWindow) {
  // Log and return - the window is closed, nothing to do
  console.warn('No window found for workspace:', workspacePath);
  return;
}

// Use the window
targetWindow.webContents.send('some-event', data);
```

**Why no fallbacks?**
- Fallbacks hide bugs instead of surfacing them
- "First visible window" is unpredictable with multiple windows
- If you don't have the workspace path, your routing is already broken
- Better to fail loudly than route to the wrong window silently

## Window State Management

### Window State Storage

Each window has state tracked in `windowStates` Map:

```typescript
interface WindowState {
  mode: 'workspace' | 'document' | 'agentic-coding';
  filePath: string | null;
  workspacePath: string | null;  // Key for routing!
  documentEdited: boolean;
}
```

### Finding Windows

```typescript
// Find by workspace path (stable)
export function findWindowByWorkspace(workspacePath: string): BrowserWindow | null

// Find by file path
export function findWindowByFilePath(filePath: string): BrowserWindow | null

// Get custom window ID from BrowserWindow
export function getWindowId(browserWindow: BrowserWindow): number | null
```

## Common Pitfalls

### ❌ WRONG: Using window ID for deferred operations

```typescript
// BAD: Window ID will be stale if user closes/reopens window
setTimeout(() => {
  const window = BrowserWindow.fromId(windowId);
  window?.webContents.send('notification-clicked');
}, 5000);
```

### ✅ CORRECT: Using workspace path for deferred operations

```typescript
// GOOD: Workspace path is stable across window lifecycle
setTimeout(() => {
  const window = findWindowByWorkspace(workspacePath);
  window?.webContents.send('notification-clicked');
}, 5000);
```

### ❌ WRONG: Storing window IDs in sessions

```typescript
// BAD: Session stores window ID (becomes stale)
const session = {
  id: 'session-123',
  windowId: event.sender.id,  // Don't store this!
  messages: []
};
```

### ✅ CORRECT: Storing workspace path in sessions

```typescript
// GOOD: Session stores workspace path (stable)
const session = {
  id: 'session-123',
  workspacePath: '/Users/john/workspace',  // Store this!
  messages: []
};
```

## Real-World Examples

### OS Notification Click Handler

```typescript
// packages/electron/src/main/services/NotificationService.ts
private handleNotificationClick(options: NotificationOptions): void {
  // REQUIRED: workspacePath must be provided
  if (!options.workspacePath) {
    throw new Error('workspacePath is required for notification routing');
  }

  // Find window by workspace path (the only stable identifier)
  const targetWindow = findWindowByWorkspace(options.workspacePath);

  if (!targetWindow) {
    logger.warn('No window found for workspace:', options.workspacePath);
    return;
  }

  // Focus window and switch to session
  targetWindow.focus();
  targetWindow.webContents.send('notification-clicked', {
    sessionId: options.sessionId
  });
}
```

### Sound Notification

```typescript
// packages/electron/src/main/services/SoundNotificationService.ts
public playCompletionSound(workspacePath: string): void {
  // REQUIRED: workspacePath must be provided
  if (!workspacePath) {
    throw new Error('workspacePath is required for sound notification routing');
  }

  // Find window by workspace path (the only stable identifier)
  const targetWindow = findWindowByWorkspace(workspacePath);

  if (!targetWindow || targetWindow.isDestroyed()) {
    console.warn('No window found for workspace:', workspacePath);
    return;
  }

  // Play sound on target window
  targetWindow.webContents.send('play-completion-sound', soundType);
}
```

### AI Streaming Response (Immediate)

```typescript
// packages/electron/src/main/services/ai/AIService.ts
ipcMain.handle('ai:sendMessage', async (event, message) => {
  // ✅ Use event.sender for immediate responses during the same call
  for await (const chunk of provider.sendMessage(message)) {
    event.sender.send('ai:streamResponse', {
      sessionId: session.id,
      partial: chunk.content,
      isComplete: false
    });
  }
});
```

## Summary

**Golden Rules:**

1. **Workspace paths are stable** - Use them for any async/deferred routing
2. **Window IDs are transient** - Only use them for immediate responses or as fallback
3. **Always implement fallback strategy** - Gracefully handle cases where routing fails
4. **Sessions belong to workspaces** - Not to specific window instances

**Quick Decision Tree:**

- **Is this an immediate IPC response?** → Use `event.sender`
- **Is this async/deferred (notifications, timers)?** → Use `workspacePath` + `findWindowByWorkspace()`
- **Do you have a workspace path?** → Always prefer it over window ID
- **Need to store for later?** → Store `workspacePath`, never `windowId`
