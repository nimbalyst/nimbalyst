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

### How the opt-out actually reaches the renderer

Sharing opt-in status is not automatic — it is wired explicitly, and it is easy to break:

- Both toggle paths (the `analytics:set-enabled` IPC from the settings UI and the `analytics_set_enabled` MCP tool) go through `applyAnalyticsEnabled` in `packages/electron/src/main/services/analytics/applyAnalyticsEnabled.ts`. It persists the setting, opts the posthog-node client in or out, and broadcasts `analytics:enabled-changed` to every window.
- The renderer holds the resolved answer in `packages/electron/src/renderer/utils/analyticsConsent.ts`. It **fails closed**: until the bootstrap resolves the setting from main, consent is denied.
- `posthog.init`'s `before_send` in `src/renderer/index.tsx` consults that gate, so no `posthog.capture(...)` call site anywhere in the renderer can leak an event while analytics are off — including call sites written later that know nothing about this.

Never write `analyticsEnabled` to the store directly. Doing so used to stop main-process events while leaving every renderer `posthog.capture(...)` firing, because nothing told the renderer the setting had changed. The broadcast is per-window on purpose: the renderer PostHog client is per-window, so toggling in the settings window has to reach the others.

### Event Naming Conventions

Follow these conventions for consistency:

- Use **snake\_case** for event names: `file_opened`, `window_closed`, `ai_chat_started`
- Use **noun\_verb** pattern: `file_opened`, `tab_switched`, `project_created`
- Group related events with prefixes:
  - `file_*`: File operations (`file_opened`, `file_created`, `file_deleted`)
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

// File created
analyticsService.sendEvent('file_created', {
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
  errorCategory: 'availability',          // Fixed enum, never raw text
  errorCode: 'wasm_runtime_crash',        // Fixed enum, never raw text
});
```

**Guidelines for known errors:**

1. **Use a unique `errorId`**: Choose a descriptive snake_case identifier (e.g., `pglite_wasm_runtime_crash`)
2. **Include `context`**: Describe where in the application the error occurred
3. **Never include raw error text**: Truncation does not make paths, usernames, document names, or secrets anonymous. Map errors to fixed categories/codes and keep detailed text in local logs only
4. **Document in POSTHOG_EVENTS.md**: Add new error IDs to the "Known Error IDs" table
5. **Don't include file paths**: Error messages commonly contain paths, so omit them from analytics entirely

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

## Nimbalyst Teams Analytics

Teams and collaboration events use a stricter shared contract than the general analytics examples above:

- Event schemas, enums, privacy validation, bucket helpers, and error categorization live in `packages/electron/src/shared/analytics/teamAnalytics.ts`.
- Renderer code emits through `trackTeamAnalyticsEvent` or `captureTeamAnalyticsEvent` in `packages/electron/src/renderer/utils/teamAnalytics.ts`.
- Main-process code emits through `sendTeamAnalyticsEvent` in `packages/electron/src/main/services/analytics/TeamAnalytics.ts`.
- Runtime sync packages expose product-neutral callbacks and state only; they do not import PostHog.

The adapters fail closed. An unknown event property, a value outside an allowlisted enum, a raw path/URL/email shape, or an unsafe high-cardinality category is rejected locally and is not sent.

### Outcome timing and deduplication

Emit product events only after the authoritative client operation succeeds. Do not emit from the initiating button click, optimistic state, individual Yjs updates, awareness messages, WebSocket messages, or polling loops.

Connection telemetry represents one coalesced attempt. `connecting`, `syncing`, and repeated identical statuses are intermediate states; one `collab_sync_attempt_completed` event is emitted only when that attempt reaches `success`, `offline_ready`, or `failed`. Outbox events are emitted only for a replay cycle that had pending work.

`collab_document_first_edited` is once per document open/attachment lifecycle. An explicit shared-document open may emit `collab_document_opened`; automatic `restart_restore` opens are excluded from the `has_opened_shared_document` person property and primary retention queries.

### Volume discipline

Several authoritative seams are reached by a debounced autosave or a retrying transport, not by a discrete user action. Instrumenting them naively produces one event per typing pause and makes both the metric and the bill unusable. Before adding a Teams event, ask what drives the seam:

- **Discrete user decision** (create, status change, assign, comment, delete, invite, share) — emit every time.
- **Debounced autosave** (tracker field saves, tracker body saves) — either do not instrument it, or route it through `AnalyticsEmissionThrottle` (`packages/electron/src/shared/analytics/analyticsThrottle.ts`). The tracker path does this in `trackerMutationAnalytics.ts`: `field_changed` collapses to one event per item per 10 minutes and body content saves are not instrumented at all.
- **Transport lifecycle** (connection attempts, outbox cycles) — cap per resource. `CollaborationHealthAttemptTracker` reports at most one attempt per resource per 60 seconds.

Apply a cap to **every outcome equally**. Throttling successes but not failures silently biases the failure-rate alerts upward. `docs/POSTHOG_EVENTS.md` records the caps currently in force; keep it in sync when you change one.

### Activation and retention

A user is Teams-activated after a meaningful collaboration outcome:

- a shared document is created or shared;
- an explicitly opened shared document receives its first local edit; or
- a tracker item with `collaborationScope=shared` is created or mutated.

Organization creation, invitation acceptance, and project attachment are setup stages, not terminal activation. Primary retention uses `collab_document_first_edited` and `tracker_item_mutated` filtered to shared scope. See `docs/TEAMS_ANALYTICS.md` for the reproducible dashboard and alert definitions.

### Teams privacy rules

Never send organization/project/document/folder/member/account/room identifiers, names, emails, titles, filenames, paths, git remotes, deep-link payloads, raw errors, URLs, tokens, content, sync payloads, or exact counts/durations/retries when the shared contract defines a bucket. Do not use PostHog Groups keyed by customer or collaboration entity.

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
