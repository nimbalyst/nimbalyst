package com.nimbalyst.app.screenshots

import com.google.gson.Gson
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.nimbalyst.app.data.MessageEntity
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.sync.DeviceInfo
import com.nimbalyst.app.sync.SyncedAvailableModel
import com.nimbalyst.app.ui.sessionlist.SessionListGrouping

/**
 * Realistic demo content for Play Store screenshots. Mirrors the iOS
 * ScreenshotDataProvider so both stores show the same product story.
 *
 * Every builder is pure and takes `now`, so the unit tests can assert on the
 * result without a device clock.
 */
object ScreenshotDemoData {
    const val SHOWCASE_PROJECT_ID = "/Users/demo/sources/nimbalyst"
    const val SHOWCASE_PROJECT_NAME = "nimbalyst"
    const val SHOWCASE_SESSION_ID = "sess-nim-1"

    const val DEMO_DRAFT =
        "Also add a system default option so the theme follows the device setting."

    private const val MINUTE = 60_000L
    private const val HOUR = 60 * MINUTE
    private const val DAY = 24 * HOUR

    private val gson = Gson()

    fun projects(): List<ProjectEntity> = listOf(
        ProjectEntity(id = SHOWCASE_PROJECT_ID, name = SHOWCASE_PROJECT_NAME, sortOrder = 0),
        ProjectEntity(id = "/Users/demo/sources/api-server", name = "api-server", sortOrder = 1),
        ProjectEntity(id = "/Users/demo/sources/design-system", name = "design-system", sortOrder = 2),
        ProjectEntity(id = "/Users/demo/sources/mobile-app", name = "mobile-app", sortOrder = 3),
    )

    const val WORKSTREAM_ID = "ws-dark-mode"
    const val ORCHESTRATOR_ID = "meta-tablet"

    fun sessions(now: Long): List<SessionEntity> = listOf(
        // A meta agent orchestrating three workers, nested under it in the list.
        session(
            id = ORCHESTRATOR_ID,
            projectId = SHOWCASE_PROJECT_ID,
            title = "Tablet layout",
            model = "claude-opus-5-5",
            updatedAt = now - 2 * MINUTE,
            agentRole = SessionListGrouping.META_AGENT_ROLE,
            isExecuting = true
        ),
        session(
            id = "sess-meta-1",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Two-pane navigation at 700dp",
            model = "claude-sonnet-5-5",
            updatedAt = now - MINUTE,
            parentSessionId = ORCHESTRATOR_ID,
            createdBySessionId = ORCHESTRATOR_ID,
            isExecuting = true,
            phase = "implementing"
        ),
        session(
            id = "sess-meta-2",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Keep selection across rotation",
            model = "claude-sonnet-5-5",
            updatedAt = now - 20 * MINUTE,
            parentSessionId = ORCHESTRATOR_ID,
            createdBySessionId = ORCHESTRATOR_ID,
            unread = true,
            phase = "validating"
        ),
        session(
            id = "sess-meta-3",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Tablet list and detail polish",
            model = "claude-sonnet-5-5",
            updatedAt = now - 45 * MINUTE,
            parentSessionId = ORCHESTRATOR_ID,
            createdBySessionId = ORCHESTRATOR_ID,
            phase = "complete"
        ),
        // A workstream container holding the showcase session and two siblings.
        session(
            id = WORKSTREAM_ID,
            projectId = SHOWCASE_PROJECT_ID,
            title = "Dark mode",
            model = "claude-sonnet-5-5",
            updatedAt = now - 3 * HOUR,
            sessionType = SessionListGrouping.WORKSTREAM_TYPE
        ),
        session(
            id = SHOWCASE_SESSION_ID,
            projectId = SHOWCASE_PROJECT_ID,
            title = "Implement dark mode theme switching",
            model = "claude-sonnet-5-5",
            updatedAt = now - 12 * MINUTE,
            parentSessionId = WORKSTREAM_ID,
            unread = true,
            phase = "implementing"
        ),
        session(
            id = "sess-dark-2",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Theme toggle in settings",
            model = "claude-sonnet-5-5",
            updatedAt = now - 35 * MINUTE,
            parentSessionId = WORKSTREAM_ID,
            phase = "validating"
        ),
        session(
            id = "sess-dark-3",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Contrast audit for the dark palette",
            model = "claude-opus-5-5",
            updatedAt = now - 50 * MINUTE,
            parentSessionId = WORKSTREAM_ID,
            phase = "planning"
        ),
        session(
            id = "sess-nim-2",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Fix authentication token refresh",
            model = "claude-sonnet-5-5",
            updatedAt = now - 3 * MINUTE,
            unread = true,
            // Waiting on a queued prompt: the orange clock, next to the running spinners above.
            hasQueuedPrompts = true
        ),
        // Two sessions sharing a git worktree.
        session(
            id = "sess-nim-3",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Session search",
            model = "claude-sonnet-5-5",
            updatedAt = now - 40 * MINUTE,
            worktreeId = "wt-session-search"
        ),
        session(
            id = "sess-nim-3b",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Highlight matches in search results",
            model = "claude-sonnet-5-5",
            updatedAt = now - 30 * MINUTE,
            worktreeId = "wt-session-search"
        ),
        session(
            id = "sess-nim-4",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Refactor database migrations",
            model = "claude-opus-5-5",
            updatedAt = now - 2 * HOUR,
            phase = "validating"
        ),
        session(
            id = "sess-nim-5",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Write unit tests for the sync protocol",
            model = "claude-sonnet-5-5",
            mode = "planning",
            updatedAt = now - 5 * HOUR,
            phase = "planning"
        ),
        session(
            id = "sess-nim-6",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Update README documentation",
            model = "claude-sonnet-5-5",
            updatedAt = now - DAY - 3 * HOUR
        ),
        session(
            id = "sess-nim-7",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Design extension API architecture",
            model = "claude-opus-5-5",
            updatedAt = now - 2 * DAY
        ),
        session(
            id = "sess-nim-8",
            projectId = SHOWCASE_PROJECT_ID,
            title = "Performance tuning for the file watcher",
            model = "claude-sonnet-5-5",
            updatedAt = now - 6 * DAY
        ),
        session(
            id = "sess-api-1",
            projectId = "/Users/demo/sources/api-server",
            title = "Add rate limiting middleware",
            model = "claude-sonnet-5-5",
            updatedAt = now - 26 * MINUTE,
            unread = true
        ),
        session(
            id = "sess-api-2",
            projectId = "/Users/demo/sources/api-server",
            title = "Implement WebSocket authentication",
            model = "claude-sonnet-5-5",
            updatedAt = now - 4 * HOUR
        ),
        session(
            id = "sess-api-3",
            projectId = "/Users/demo/sources/api-server",
            title = "Database connection pooling setup",
            model = "claude-opus-5-5",
            updatedAt = now - DAY
        ),
        session(
            id = "sess-ds-1",
            projectId = "/Users/demo/sources/design-system",
            title = "Token pipeline for color primitives",
            model = "claude-sonnet-5-5",
            updatedAt = now - 55 * MINUTE
        ),
        session(
            id = "sess-ds-2",
            projectId = "/Users/demo/sources/design-system",
            title = "Audit button variants for contrast",
            model = "claude-sonnet-5-5",
            updatedAt = now - 3 * DAY
        ),
        session(
            id = "sess-mob-1",
            projectId = "/Users/demo/sources/mobile-app",
            title = "Offline queue for pending prompts",
            model = "claude-sonnet-5-5",
            updatedAt = now - 90 * MINUTE
        ),
        session(
            id = "sess-mob-2",
            projectId = "/Users/demo/sources/mobile-app",
            title = "Push notification deep links",
            model = "claude-sonnet-5-5",
            updatedAt = now - 2 * DAY - 4 * HOUR
        ),
    )

    /** Transcript for the showcase session (the "detail" and "composer" screens). */
    fun messages(now: Long): List<MessageEntity> = listOf(
        userMessage(
            id = "msg-1",
            sequence = 1,
            prompt = "Help me implement dark mode theme switching. I want a toggle in " +
                "settings that persists the preference and updates every color instantly.",
            createdAt = now - 120 * MINUTE
        ),
        assistantMessage(
            id = "msg-2",
            sequence = 2,
            text = """
                I'll add a `ThemeController` that persists the preference and broadcasts changes to Compose. Here's the plan:

                1. Store the mode in `DataStore` so it survives process death
                2. Expose it as a `StateFlow<ThemeMode>` the theme reads
                3. Add the toggle to the settings screen
                4. Drive `MaterialTheme` from the collected value

                Starting with the controller.
            """.trimIndent(),
            createdAt = now - 119 * MINUTE
        ),
        toolUseMessage(
            id = "msg-3",
            sequence = 3,
            toolName = "Write",
            input = mapOf(
                "file_path" to "app/src/main/java/com/nimbalyst/app/ui/theme/ThemeController.kt",
                "content" to """
                    class ThemeController(
                        private val store: SettingsStore,
                    ) {
                        val mode = store.themeMode

                        suspend fun set(mode: ThemeMode) {
                            store.setThemeMode(mode)
                        }
                    }
                """.trimIndent()
            ),
            createdAt = now - 118 * MINUTE
        ),
        toolResultMessage(
            id = "msg-4",
            sequence = 4,
            toolUseId = "toolu_screenshot_write",
            content = "File written: app/src/main/java/com/nimbalyst/app/ui/theme/ThemeController.kt",
            createdAt = now - 118 * MINUTE + 500
        ),
        assistantMessage(
            id = "msg-5",
            sequence = 5,
            text = """
                `ThemeController` is in place with:

                - **DataStore persistence** so the choice survives restarts
                - **A `StateFlow`** the theme collects, so every color updates in one recomposition
                - **No blocking reads** on the main thread

                Next I'll wire the toggle into the settings screen.
            """.trimIndent(),
            createdAt = now - 117 * MINUTE
        ),
        userMessage(
            id = "msg-6",
            sequence = 6,
            prompt = "Can you also add a system default option, so it follows the device setting?",
            createdAt = now - 60 * MINUTE
        ),
        assistantMessage(
            id = "msg-7",
            sequence = 7,
            text = """
                Done -- the controller now supports three modes, and `System` defers to the device:

                ```kotlin
                val dark = when (mode) {
                    ThemeMode.SYSTEM ->
                        isSystemInDarkTheme()
                    ThemeMode.LIGHT -> false
                    ThemeMode.DARK -> true
                }
                ```

                `isSystemInDarkTheme()` recomposes on its own when the device setting flips, so nothing else has to listen for it.
            """.trimIndent(),
            createdAt = now - 58 * MINUTE
        ),
    )

    /**
     * Placeholder credentials so the paired/authenticated UI renders. The JWT is
     * a literal string, not a token: screenshot mode never opens a socket.
     */
    fun pairingCredentials(): PairingCredentials = PairingCredentials(
        serverUrl = "wss://sync.nimbalyst.com",
        encryptionSeed = "screenshot-mode-seed",
        pairedUserId = "demo@nimbalyst.com",
        authJwt = "screenshot-mode-not-a-token",
        authUserId = "member-demo",
        orgId = "org-demo",
        personalUserId = "user-demo",
        personalOrgId = "org-demo-personal",
        authEmail = "demo@nimbalyst.com"
    )

    fun connectedDevices(now: Long): List<DeviceInfo> = listOf(
        DeviceInfo(
            deviceId = "device-demo-desktop",
            name = "Demo MacBook Pro",
            type = "desktop",
            platform = "desktop",
            appVersion = "1.0.0",
            connectedAt = now - 3 * HOUR,
            lastActiveAt = now - MINUTE,
            isFocused = true
        ),
        // Fills out the computer picker: a headless machine and an offline desktop.
        DeviceInfo(
            deviceId = "device-demo-sandbox",
            name = "Cloud sandbox",
            type = "headless",
            platform = "linux",
            appVersion = "1.0.0",
            connectedAt = now - 5 * HOUR,
            lastActiveAt = now - 2 * MINUTE,
            isOnline = true
        ),
        DeviceInfo(
            deviceId = "device-demo-studio",
            name = "Studio iMac",
            type = "desktop",
            platform = "desktop",
            appVersion = "1.0.0",
            connectedAt = now - 2 * DAY,
            lastActiveAt = now - DAY,
            isOnline = false,
            lastSeenAt = now - DAY
        )
    )

    /** What the desktop publishes for the new-session model picker. */
    fun availableModels(): List<SyncedAvailableModel> = listOf(
        SyncedAvailableModel("claude-code:opus", "Claude Opus 5.5", "claude-code"),
        SyncedAvailableModel("claude-code:fable", "Claude Fable 5.1", "claude-code"),
        SyncedAvailableModel("claude-code:sonnet", "Claude Sonnet 5.5", "claude-code"),
        SyncedAvailableModel("claude-code:haiku", "Claude Haiku 5.5", "claude-code"),
        SyncedAvailableModel("openai-codex:gpt-5.6-sol", "GPT-5.6 Sol", "openai-codex"),
        SyncedAvailableModel("claude:claude-sonnet-5-5", "Claude Sonnet 5.5", "claude"),
        SyncedAvailableModel("openai:gpt-5.5", "GPT-5.5", "openai"),
    )

    const val DEFAULT_MODEL_ID = "claude-code:opus"

    /** Path of the file the "document" screen opens. */
    const val SHOWCASE_DOCUMENT_PATH = "plans/dark-mode.md"

    /** Directories the Files tab shows expanded (their tree paths are the expansion keys). */
    val EXPANDED_DOCUMENT_DIRS = setOf("plans", "docs")

    data class DemoDocument(val syncId: String, val relativePath: String, val markdown: String, val modifiedAgo: Long)

    fun documents(): List<DemoDocument> = listOf(
        DemoDocument("doc-readme", "README.md", "# Nimbalyst\n\nAn AI-native workspace for docs, code, and agent sessions.\n", 2 * DAY),
        DemoDocument("doc-changelog", "CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n- Tablet layout with list and detail side by side\n", 3 * HOUR),
        DemoDocument("doc-arch", "docs/architecture.md", "# Architecture\n\nThe desktop app owns sessions; phones mirror them over encrypted sync.\n", 4 * DAY),
        DemoDocument("doc-sync", "docs/sync-protocol.md", "# Sync protocol\n\nEvery message is encrypted on the device before it is sent.\n", 6 * DAY),
        DemoDocument("doc-onboard", "docs/onboarding.md", "# Onboarding\n\nPair a phone by scanning the QR code in desktop settings.\n", 5 * DAY),
        DemoDocument("doc-dark", SHOWCASE_DOCUMENT_PATH, DARK_MODE_PLAN, 12 * MINUTE),
        DemoDocument("doc-tablet", "plans/tablet-layout.md", "# Tablet layout\n\nList and detail sit side by side from 700dp.\n", 2 * HOUR),
        DemoDocument("doc-search", "plans/session-search.md", "# Session search\n\nSearch titles locally, then fill in from history.\n", DAY),
        DemoDocument("doc-release", "notes/release-checklist.md", "# Release checklist\n\n- [ ] Screenshots\n- [ ] Changelog\n", 2 * DAY),
        DemoDocument("doc-standup", "notes/standup.md", "# Standup\n\n- Dark mode in review\n", 5 * HOUR),
    )

    private val DARK_MODE_PLAN = """
        # Dark mode theme switching

        Let people pick **Light**, **Dark**, or **System**, and apply the choice instantly without a restart.

        ## Goals

        - Persist the preference so it survives process death
        - Recolor every screen in a single recomposition
        - Follow the device setting when *System* is selected

        ## Plan

        - [x] Add `ThemeController` backed by DataStore
        - [x] Expose the mode as a `StateFlow`
        - [ ] Add the toggle to Settings
        - [ ] Contrast audit for the dark palette

        ## Open questions

        1. Should the transcript follow the app theme or the system theme?
        2. Do we need a per-project override?

        > Ship behind no flag: the default stays *System*, so nobody sees a change until they opt in.
    """.trimIndent()

    private fun session(
        id: String,
        projectId: String,
        title: String,
        model: String,
        updatedAt: Long,
        mode: String = "agent",
        phase: String? = null,
        unread: Boolean = false,
        isExecuting: Boolean = false,
        hasQueuedPrompts: Boolean = false,
        sessionType: String? = null,
        parentSessionId: String? = null,
        worktreeId: String? = null,
        agentRole: String? = null,
        createdBySessionId: String? = null,
    ): SessionEntity = SessionEntity(
        id = id,
        projectId = projectId,
        titleDecrypted = title,
        provider = "claude-code",
        model = model,
        mode = mode,
        phase = phase,
        isExecuting = isExecuting,
        hasQueuedPrompts = hasQueuedPrompts,
        sessionType = sessionType,
        parentSessionId = parentSessionId,
        worktreeId = worktreeId,
        agentRole = agentRole,
        createdBySessionId = createdBySessionId,
        createdAt = updatedAt - HOUR,
        updatedAt = updatedAt,
        lastMessageAt = updatedAt,
        lastReadAt = if (unread) null else updatedAt + 1
    )

    private fun userMessage(id: String, sequence: Int, prompt: String, createdAt: Long) =
        MessageEntity(
            id = id,
            sessionId = SHOWCASE_SESSION_ID,
            sequence = sequence,
            source = "user",
            direction = "input",
            contentDecrypted = envelope(JsonObject().apply { addProperty("prompt", prompt) }),
            createdAt = createdAt
        )

    private fun assistantMessage(id: String, sequence: Int, text: String, createdAt: Long) =
        outputMessage(
            id = id,
            sequence = sequence,
            inner = JsonObject().apply {
                addProperty("type", "text")
                addProperty("content", text)
            },
            createdAt = createdAt
        )

    private fun toolUseMessage(
        id: String,
        sequence: Int,
        toolName: String,
        input: Map<String, String>,
        createdAt: Long,
    ) = outputMessage(
        id = id,
        sequence = sequence,
        inner = JsonObject().apply {
            addProperty("type", "tool_use")
            addProperty("id", "toolu_screenshot_${toolName.lowercase()}")
            addProperty("name", toolName)
            add("input", gson.toJsonTree(input))
        },
        createdAt = createdAt
    )

    private fun toolResultMessage(
        id: String,
        sequence: Int,
        toolUseId: String,
        content: String,
        createdAt: Long,
    ) = outputMessage(
        id = id,
        sequence = sequence,
        inner = JsonObject().apply {
            addProperty("type", "tool_result")
            addProperty("tool_use_id", toolUseId)
            addProperty("content", content)
        },
        createdAt = createdAt
    )

    private fun outputMessage(id: String, sequence: Int, inner: JsonObject, createdAt: Long) =
        MessageEntity(
            id = id,
            sessionId = SHOWCASE_SESSION_ID,
            sequence = sequence,
            source = "claude-code",
            direction = "output",
            contentDecrypted = envelope(inner),
            createdAt = createdAt
        )

    /** The sync envelope the transcript expects: {"content":"<inner json>","metadata":null,"hidden":false}. */
    private fun envelope(inner: JsonObject): String {
        val outer = JsonObject().apply {
            addProperty("content", gson.toJson(inner))
            add("metadata", JsonNull.INSTANCE)
            addProperty("hidden", false)
        }
        return gson.toJson(outer)
    }
}
