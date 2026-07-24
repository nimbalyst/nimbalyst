## End-to-End Verification Before Declaring Victory

For any bug whose verification requires a user `/restart` or a user manually exercising a UI flow, the **first** deliverable is a failing test that the fix must make pass. No "the code path looks right" or "tests pass" claims before a reproducible test flips from red to green with the fix applied.

This rule exists because the same failure mode keeps recurring at increasing cost. A logged one-off mistake on 2026-05-13 ("restart heals iOS" claim without tracing the bulk sync path) became a 5-session workstream on 2026-05-20 where agents announced "fixed" four separate times — each time the user restarted, opened the affected tracker, and the body was still empty (or showing "asd"). The user's escalation: "you're killing me. launch a new sibling session to get this all working."

### Key points

- **Failing test first.** Before any code fix for a restart-to-verify bug, write a test (E2E, integration, or scripted-IPC) that reproduces the bug. Run it. Confirm it fails. Only then write the fix.
- **"Tests pass" ≠ "the user can do the thing."** For UI/UX bugs, the test must exercise the user-visible flow. A unit test on the patched function is not sufficient for a bug that's only observable after restart.
- **Don't announce "fixed" without verification.** If you have not personally observed the bug go from broken to working (via a test that flips red→green, or by reading logs that show the failing step now succeeding), say plainly: "I made the change; the path is unverified end-to-end."
- **For collab/sync bugs, verify both sides.** Local PGLite state matches the test fixture is not sufficient evidence that the server-side Y.Doc / DurableObject also matches. Inspect the live room state (wrangler-backed E2E, or direct DO inspection) before claiming a sync bug is closed.
- **`try { … } catch { console.error }` blocks silently swallow your fix.** If your change runs inside one, grep `main.log` for the catch-block error string immediately after exercising the path. Don't trust silence.
- **Restart-to-verify is a cost signal.** If a bug requires restarting Nimbalyst to test a fix, the next session should write a test that doesn't require restart (scripted IPC, headless E2E, mocked main process). Each restart cycle is ~30 seconds of user time × N failed attempts.

### When this rule applies

- Bugs reported as "still not fixed after restart"
- Any change to main-process initialization, IPC handlers, sync handlers, or yJS document seeding
- UI bugs that only manifest after Electron full reload
- Anything where the user has already restarted once in the conversation
