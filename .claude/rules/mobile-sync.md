## Mobile Sync: Desktop to iOS

The personal sync path (desktop `SyncProvider` publish, collab worker, Swift `SyncManager` ingest) has failed the same way repeatedly: a send whose outcome nobody read, an ack that raced the state it described, a consumer that trusted whatever arrived last. Four fixes on 2026-09-12 re-fixed two areas already fixed in August. These rules apply to `packages/runtime/src/sync/`, `packages/electron/src/main/services/SyncManager.ts`, `packages/electron/src/main/services/sync/`, `packages/electron/src/main/services/ai/MobileSyncHandler.ts`, `packages/collab-protocol/`, and `packages/ios/NimbalystNative/Sources/Sync/`.

### Every send returns an outcome, and the caller reads it

- `pushChange` and its siblings return a `PushChangeOutcome` instead of throwing. A caller that fires it without `await` and without reading `published` has decided the phone does not need the data. Say so in a comment or read the outcome.
- On iOS, no request leaves `SyncManager` without a completion, a timeout, and a place for the failure to land. `SessionCreationRequests.swift` is the template. A `sendRaw` with no completion is not allowed for anything a user is waiting on.
- `catch { logger.error(...) }` is not error handling on this path. Either the failure feeds `syncError` (iOS) or a retry the code can name, or the catch carries a comment saying why silence is correct for this message.

### Ack after persist

- Desktop answers a phone request only after the state the answer refers to has a publish outcome. Sending `createSessionResponse` before `syncSessionsToIndex` resolves tells the phone to open a session that does not exist yet.
- On an unpublished outcome, answer with `success: false` and the reason. A success the phone cannot act on is worse than a failure it can show.
- iOS completes a request only when the committed row is observable, not when the ack arrives. `SessionCreationTracker.swift` shows the pattern: observe the GRDB row, keep the timeout, tolerate a duplicate ack.

### Guard every consumer on revision or timestamp

- A broadcast, page, or settings payload can arrive late, twice, or from a desktop that restarted. Every apply path compares against the last applied revision, sequence, or timestamp and rejects the stale one. The v2 index page path in `IndexReplicationEntry.swift` does this; the settings, metadata, and message broadcast paths must match it.
- A field that exists to order writes (`draftUpdatedAt`, `settingsVersion`, `sequence`) is compared, not merely carried along.
- Desktop-side version counters persist across restarts. A counter that resets to zero on launch guarantees a replay overwrites newer state after the next device join.

### Commit local state after the send, or record that it did not send

- On desktop, capture the socket, connection generation, and cache identity before the encryption `await`, re-check after, and set the cache only after `socket.send` returns (`CollabV3Sync.ts` `sendIndexUpdate`).
- On iOS, an optimistic local write is fine for the UI, but the send outcome is recorded and the row is re-published on reconnect. Local and server state must not diverge silently.

### The sync layer owns sync, not a view

Publishing slash commands, action prompts, project files, or any other slice must not depend on a renderer component or a SwiftUI view mounting. `projectConfigSync` on desktop is the owner for project config; per-project document sync is connected by `SyncManager`, not by a list view's `onAppear`. Reconnect re-drives every slice.

### A wire field lands on both sides plus the fixture, in one commit

- Wire types are hand-mirrored between `packages/collab-protocol` / `packages/runtime/src/sync/types.ts` and `SyncProtocol.swift`. The golden fixtures in `packages/collab-protocol/fixtures/` are the executable contract: a field added to a TypeScript type without the fixture fails the runtime test, and a fixture field the Swift type does not decode fails the Swift test.
- Adding an inbound field on iOS without the outbound counterpart (or the reverse) is the shape of the `updateSessionParent` bug: a local write with a comment promising propagation that never happens.

### Failing test first, then fix, then keep the file smaller

- A sync bug fix starts with a fixture or a round-trip scenario that fails on the current code. "The code path looks right" is not evidence on this path; see `end-to-end-verification.md`.
- `CollabV3Sync.ts`, `SyncManager.swift`, and `SyncManager.ts` may not grow. Extract what you touch into a sibling module.
- Local PGLite or GRDB state is not proof of server state. For anything that claims the phone will see it, read the server side or the Swift ingest.
