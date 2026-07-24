# Analytics Guide for Nimbalyst

This document explains how to use the analytics tracking service in the Electron application. The service is built on PostHog and designed to collect anonymous usage data while respecting user privacy.

## Architecture Overview

The analytics service is a singleton that runs exclusively in the main process:
- **Main process**: `AnalyticsService` class in `packages/electron/src/main/services/analytics/AnalyticsService.ts`
- **Renderer process**: Use the `usePostHog` hook from `posthog-js/react` for client-side tracking
- **Separation of concerns**: Server-side events use `AnalyticsService`, client-side events use the PostHog React SDK

This separation ensures that Electron-specific events (window management, file operations, system interactions) are tracked server-side, while UI interactions can be tracked client-side.

## Critical Privacy Requirements

**IMPORTANT: All analytics must be anonymous.**

### Anonymity Rules

1. **Never override the distinctId**: The service generates a unique anonymous ID (`nimbalyst_${ulid()}`). Do not attempt to override this with usernames, emails, or other identifying information.

2. **No identifying information in event properties**: Event properties must not contain:
  - Usernames or email addresses
  - IP addresses (PostHog privacy mode handles this)
  - File paths that could reveal user identity
  - API keys or tokens
  - Any personally identifiable information (PII)

3. **Opt-out retention ping**: Even when users opt out of analytics, the service sends a single `nimbalyst_session_start` event on application start. This allows us to track retention statistics (how many active unique installations exist) without tracking individual user behavior. This is the only event sent for opted-out users.

### Dev User Tracking

Users are automatically marked with the `is_dev_user` person property if they have ever used a non-official build. This includes:
- Development builds (`npm run dev`)
- Local builds (`npm run build:mac:local`)
- Any build not created by the official GitHub release workflow

**Key characteristics:**
- The `is_dev_user` property is set using PostHog's `$set_once`, meaning once a user is marked as a dev user, they remain marked forever
- This allows you to filter out dev users in PostHog queries while still collecting their analytics
- Official GitHub release builds have `OFFICIAL_BUILD=true` environment variable set by the CI/CD workflow
- Dev users are tracked in both the main process (via `AnalyticsService`) and renderer process (via PostHog React SDK)

**Filtering dev users in PostHog:**
```
# Exclude dev users from your insights
WHERE is_dev_user != true

# Or only show dev users
WHERE is_dev_user = true
```

### Good vs Bad Event Properties

**Good (anonymous):**
```typescript
analyticsService.sendEvent('file_opened', {
  fileType: 'markdown',
  sizeCategory: 'medium',  // e.g., small/medium/large buckets
  hasImages: true,
});
```

**Bad (contains PII or customer secrets):**
```typescript
// DO NOT DO THIS
analyticsService.sendEvent('file_opened', {
  filePath: '/Users/john.smith/Documents/secret.md',  // Contains username and FS path
  fileName: 'client-contract.md',  // Could be sensitive
  userEmail: 'user@example.com',  // PII
});

// AND NEVER DO THIS!!
analyticsSession.sendEvent('ai_create_session', {
	provider: 'claude',
	apiKey: config.apiKey, // NEVER PUT SECRET VALUES IN EVENT PAYLOADS!
});
```

## Using the Analytics Service to capture events

### In the Electon Main process, use the singleton analytics service

The `AnalyticsService` is a singleton initialized at application startup:

```typescript
import { AnalyticsService } from './services/analytics/AnalyticsService';

const analyticsService = AnalyticsService.getInstance();
```

### Sending Events

Use the `sendEvent` method to track user actions:

```typescript
analyticsService.sendEvent('event_name', {
  property1: 'value1',
  property2: 123,
});
```

Events are sent from all builds (both dev and official) if:
1. A valid analytics ID exists
2. The PostHog client is initialized

Dev users are automatically marked with the `is_dev_user` property, allowing you to filter them out in PostHog queries while still collecting their analytics data. If these conditions aren't met, the event is logged but not sent.

### In the Render process, use the React hook

For UI interactions that don't involve the main process, use the PostHog React SDK:

```typescript
import { usePostHog } from 'posthog-js/react';

function MyComponent() {
  const posthog = usePostHog();

  const handleClick = () => {
    posthog?.capture('button_clicked', {
      buttonType: 'primary',
      location: 'toolbar',
    });
  };

  return <button onClick={handleClick}>Click me</button>;
}
```

The renderer-side PostHog instance communicates with the main service over the electron IPC bridge during initialization and shares the same `distinctId` , `sessionId` , and opt-in status as the main process service, ensuring consistent tracking in both contexts.

### Event Naming Conventions

Follow these conventions for consistency:

- Use **snake\_case** for event names: `file_opened`, `window_closed`, `ai_chat_started`
- Use **noun\_verb** pattern: `file_opened`, `tab_switched`, `project_created`
- Group related events with prefixes:
  - `file_*`: File operations (`file_opened`, `file_saved`, `file_deleted`)
  - `window_*`: Window management (`window_opened`, `window_closed`, `window_resized`)
  - `ai_*`: AI features (`ai_chat_started`, `ai_message_sent`, `ai_diff_applied`)
  - `project_*`: Project operations (`project_opened`, `project_created`)

### Property Guidelines

Properties should be:
- **Categorical**: Use buckets instead of exact values (`sizeCategory: 'large'` not `fileSize: 15234567`)
- **Enums**: Predefined sets of values (`theme: 'dark'`, `provider: 'claude'`)
- **Safe: **property values should NEVER contain secret values such as API keys or environment variables.

### Session Tracking

The service automatically includes a `$session_id` property in all events. Sessions are synchronized with the renderer-side PostHog client:

```typescript
// Renderer sends session ID to main process
analyticsService.setSessionId(sessionId);
```

This happens automatically through IPC—you shouldn't need to call this yourself.

## Opt-In and Opt-Out

### User Consent

Users control analytics through application settings. The service respects their choice:

```typescript
// User opts in
await analyticsService.optIn();

// User opts out
await analyticsService.optOut();
```

When opting out, the service:
1. Sends a final `analytics_opt_out` event
2. Calls the opt-out functions on both the main and renderer services' posthog clients.
3. Updates settings to disable analytics

**Retention Ping**: Even after opt-out, a single `nimbalyst_session_start` event is sent on each application start via the `sessionTracker` PostHog instance (which is force-opted-in). This allows counting unique installations without tracking individual behavior. The `sessionTracker` client must never be modified to send normal events because it ignores the user's tracking preferences.

### Checking Analytics Status

Before sending events, you can check if analytics are enabled:

```typescript
if (analyticsService.allowedToSendAnalytics()) {
  // Send event
}
```

However, `sendEvent` already includes this check, so you typically don't need to check manually.

## Common Use Cases

### Tracking Feature Usage

```typescript
// User enables AI chat
analyticsService.sendEvent('ai_chat_enabled', {
  provider: 'claude',  // No API keys!
});

// User applies diff
analyticsService.sendEvent('ai_diff_applied', {
  acceptedAll: true,
});
```

### Tracking File Operations

```typescript
// File opened
analyticsService.sendEvent('file_opened', {
  sizeCategory: getSizeCategory(fileSize),    // 'small', 'medium', 'large'
});

// File saved
analyticsService.sendEvent('file_saved', {
  fileType: 'markdown',
});
```

### Tracking Window Events

```typescript
// Window opened
analyticsService.sendEvent('window_opened', {
  windowType: 'editor',
  isFirstWindow: BrowserWindow.getAllWindows().length === 1,
});

// Window closed
analyticsService.sendEvent('window_closed', {
  windowType: 'session_manager',
  openWindowCount: BrowserWindow.getAllWindows().length - 1,
});
```

### Setting Person Properties

Use `posthog.people.set()` to attach properties to a user's profile. These persist across sessions and can be used for segmentation.

```typescript
// In renderer process
const posthog = usePostHog();

// Set person properties (these persist to user profile)
posthog?.people.set({
  developer_mode: true,
  user_role: 'Software Developer',
});
```

**Guidelines for person properties:**

1. **Use for user-level attributes**: Things that describe the user, not individual actions
2. **Document in POSTHOG_EVENTS.md**: Add new properties to the "Person Properties" table
3. **Prefer set over set_once**: Use `$set_once` only for properties that should never change (like `is_dev_user`)
4. **Keep values categorical**: Use strings or booleans, not raw numbers

### Submitting Survey Responses

For API-type surveys (programmatic submission), use the `survey sent` event:

```typescript
posthog?.capture('survey sent', {
  $survey_id: 'your-survey-id',
  $survey_name: 'Survey Name',
  $survey_response: 'Answer to first question',
  $survey_response_1: 'Answer to second question',  // 0-indexed after first
});
```

### Tracking Known Errors

Use the `known_error` event to track recognized error conditions that we want to monitor. This provides a single event type for all known errors, with an `errorId` property to distinguish between them.

```typescript
// Track a known error condition
analyticsService.sendEvent('known_error', {
  errorId: 'pglite_wasm_runtime_crash',  // Unique identifier for this error type
  context: 'database_initialization',     // Where the error occurred
  // Optional: include a truncated error message for unknown variants
  // errorMessage: errorMessage.slice(0, 200),
});
```

**Guidelines for known errors:**

1. **Use a unique `errorId`**: Choose a descriptive snake_case identifier (e.g., `pglite_wasm_runtime_crash`)
2. **Include `context`**: Describe where in the application the error occurred
3. **Truncate error messages**: If including raw error text, truncate to 200 chars to avoid PII in stack traces
4. **Document in POSTHOG_EVENTS.md**: Add new error IDs to the "Known Error IDs" table
5. **Don't include file paths**: Error messages may contain paths - sanitize or omit them

## Lifecycle Management

The service is initialized automatically when the main process starts and shut down when the application quits:

```typescript
// During app startup (already done in main/index.ts)
analyticsService.init();

// During app quit (already done in main/index.ts)
await analyticsService.destroy();
```

The `destroy()` method ensures all pending events are flushed to PostHog before the application exits. It logs the shutdown duration for monitoring.

## Logging

All analytics operations are logged to the analytics logger:

```typescript
this.log.info(`event: ${eventName}`, eventProperties);
```

This helps with debugging and provides visibility into what events are being sent. Logs include:
- Service initialization with analytics ID and consent status
- Each event with its properties
- Session ID changes
- Opt-in/opt-out actions
- Service shutdown timing

## Best Practices

1. **Think in aggregates**: Instead of tracking exact values, use buckets and categories. Exact values have almost no queryable utility in posthog.
2. **Prefix related events**: Keep event names organized with consistent prefixes
3. **Document your events**: Add comments explaining what each event tracks and why
4. **Test with opt-out**: Ensure your code works correctly when analytics are disabled
5. **Review properties**: Before shipping, review all event properties to ensure no PII is included

## Examples of Good Analytics

### Feature Adoption

```typescript
// Track which AI providers are being used
analyticsService.sendEvent('ai_provider_configured', {
  provider: 'claude',  // or 'openai', 'lmstudio', 'claude-code'
  modelCount: 3,       // How many models selected
});
```

### Performance Monitoring

```typescript
// Track editor load time (bucketed)
const loadTime = Date.now() - startTime;
analyticsService.sendEvent('editor_loaded', {
  loadTimeCategory: getLoadTimeCategory(loadTime),  // 'fast', 'medium', 'slow'
  documentSize: getSizeCategory(documentLength),
});
```

### User Journey

```typescript
// Track onboarding completion
analyticsService.sendEvent('onboarding_completed', {
  stepsCompleted: 5,
  timeSpentCategory: 'medium',  // 'quick', 'medium', 'thorough'
});
```

## Security Considerations

- **Privacy**: These tracking clients are pre-configured for anonymity--do not attempt to override these configuration values. Never attempt to override the distinctID used to send events.
- **Minimal data**: Only send the minimum data needed to understand feature usage
- **No sensitive content**: Never include document content, file names, or file paths in events
- **User control**: Always respect the user's opt-out choice
- **Transparent retention ping**: The opt-out retention ping is documented and necessary for business metrics

## Debugging

To verify analytics are working:

1. Check the logs in Console.app or `~/Library/Application Support/@nimbalyst/electron/logs/`
2. Look for log entries from the analytics logger
3. Verify events appear in the PostHog dashboard (for team members with access)
4. Test both opted-in and opted-out scenarios

## Client-Side Analytics (Renderer Process)

## Summary

The analytics service provides anonymous usage tracking that respects user privacy. Remember:

- All tracking is anonymous—never include PII
- Opted-out users only send a retention ping on app start
- Use categorical properties instead of exact values
- Follow naming conventions for consistency
- Client-side events use the PostHog React SDK
- Server-side events use `AnalyticsService.getInstance().sendEvent()`

Following these guidelines ensures we can understand how users interact with Nimbalyst while maintaining their privacy and trust.
