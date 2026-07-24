# Logging Infrastructure

## Overview

The Nimbalyst uses a multi-layered logging system that captures both main process and renderer process logs. All browser console output is automatically captured and written to log files, making it accessible for debugging and AI-assisted development.

## Log File Locations

### macOS
- **Renderer Console Log**: `~/Library/Application Support/@nimbalyst/electron/renderer-console.log`
- **Main Process Log**: Application logs are also output to the terminal when running in development mode

### Windows
- **Renderer Console Log**: `%APPDATA%/@nimbalyst/electron/renderer-console.log`

### Linux
- **Renderer Console Log**: `~/.config/@nimbalyst/electron/renderer-console.log`

## Logging Levels

The logging system supports multiple levels:
- `VERBOSE` - Detailed debugging information
- `INFO` - General information messages
- `WARNING` / `WARN` - Warning messages
- `ERROR` - Error messages

## How to Use Logging

### In Renderer Process (React Components)

```javascript
// Basic console methods work and are captured
console.log('This will be logged to the file');
console.info('Info message');
console.warn('Warning message');
console.error('Error message');

// For structured logging with categories
console.log('[COMPONENT_NAME] Action description:', data);

// Example from App.tsx
console.log('[FILE_SYNC] Syncing current file path to backend:', filePath);
console.log('[AUTOSAVE] Starting save attempt...');
```

### In Main Process

```javascript
import log from 'electron-log';

log.info('Main process message');
log.error('Error in main process:', error);
```

## Log Format

Logs are formatted with timestamps and metadata:
```
[2025-08-30T06:31:57.532Z] [INFO] [http://localhost:5273/App.tsx] Message here (line 785)
```

Format breakdown:
- `[timestamp]` - ISO 8601 timestamp
- `[level]` - Log level (INFO, ERROR, etc.)
- `[source]` - Source file URL
- `message` - The actual log message
- `(line X)` - Line number in source

## Conditional Logging

To reduce log noise, use conditional logging:

```javascript
// Only log in development
if (process.env.NODE_ENV === 'development') {
  console.log('[DEBUG] Development only message');
}

// Feature-specific logging flags
const ENABLE_AUTOSAVE_LOGS = false;
if (ENABLE_AUTOSAVE_LOGS) {
  console.log('[AUTOSAVE] Detailed autosave info');
}
```

## Important: AI Development Integration

**All browser console output is automatically captured to a file.** This is crucial for AI-assisted development:

1. **Claude Code Integration**: The AI assistant can read the log file at `~/Library/Application Support/@nimbalyst/electron/renderer-console.log` to understand application behavior and debug issues.

2. **Why File Logging**: Since Claude Code cannot directly access the browser's DevTools console, all console output is mirrored to a file that the AI can read. This allows Claude to:
   - Debug runtime errors
   - Understand application flow
   - Identify performance issues
   - Track feature behavior

3. **Best Practices for AI-Readable Logs**:
   - Use descriptive prefixes: `[COMPONENT_NAME]` or `[FEATURE_NAME]`
   - Include relevant data in logs (but never sensitive information)
   - Log both successes and failures
   - Include context about what the code is trying to do

## Common Log Categories

Current categories used in the codebase:
- `[FILE_SYNC]` - File synchronization operations
- `[AUTOSAVE]` - Autosave functionality
- `[PROJECT_FILE_SELECT]` - Project file selection
- `[FILE-WATCHER]` - File system watching
- `[PROJECT-WATCHER]` - Project directory watching
- `[SESSION]` - Session management
- `[MCP]` - Model Context Protocol operations
- `[HMR]` - Hot Module Replacement
- `[AUTO-SNAPSHOT]` - Automatic document snapshots

## Debugging Tips

1. **Tail the log file** to see real-time output:
   ```bash
   tail -f ~/Library/Application\ Support/@nimbalyst/electron/renderer-console.log
   ```

2. **Search for specific errors**:
   ```bash
   grep "ERROR" ~/Library/Application\ Support/@nimbalyst/electron/renderer-console.log
   ```

3. **Filter by component**:
   ```bash
   grep "\[AUTOSAVE\]" ~/Library/Application\ Support/@nimbalyst/electron/renderer-console.log
   ```

## Configuration

### Disabling Specific Log Categories

The main App.tsx file includes a `LOG_CONFIG` object that controls which log categories are active:

```javascript
// In App.tsx - already configured
const LOG_CONFIG = {
  AUTOSAVE: false,  // Autosave logs are disabled by default
  FILE_SYNC: true,  // File sync logs are enabled
  PROJECT_FILE_SELECT: true,
  HMR: true,
  AUTO_SNAPSHOT: true,
};
```

To enable/disable specific categories, simply change the boolean values. The code uses these flags like:

```javascript
if (LOG_CONFIG.AUTOSAVE) {
  console.log('[AUTOSAVE] Starting save...');
}
```

**Note**: Autosave logging is disabled by default because it's very verbose (logs every 10 seconds). Enable it only when debugging autosave issues.

### Log Rotation

The renderer console log is cleared each time the application starts in development mode. In production, consider implementing log rotation to prevent excessive file sizes.

## Security Considerations

⚠️ **Never log sensitive information**:
- API keys or tokens
- User passwords
- Personal identifiable information (PII)
- File contents containing sensitive data

## Performance Considerations

- Excessive logging can impact performance
- Use conditional logging in performance-critical code paths
- Consider using `console.time()` and `console.timeEnd()` for performance measurements
- In production builds, consider reducing log verbosity

## Future Improvements

Potential enhancements to consider:
- [ ] Implement log levels that can be configured at runtime
- [ ] Add log filtering in the UI
- [ ] Implement structured logging with JSON format
- [ ] Add remote logging for production error tracking
- [ ] Create a log viewer within the application