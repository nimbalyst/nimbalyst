import Foundation

/// Provides an in-memory database pre-populated with realistic demo data
/// for App Store screenshot capture. Used with `--screenshot-mode` launch argument.
#if DEBUG
public struct ScreenshotDataProvider {

    /// Creates an in-memory DatabaseManager populated with realistic demo data.
    public static func createPopulatedDatabase() throws -> DatabaseManager {
        let db = try DatabaseManager()
        try insertProjects(db)
        try insertSessions(db)
        try insertMessages(db)
        try db.refreshAllProjectStats()
        return db
    }

    // MARK: - Projects

    private static func insertProjects(_ db: DatabaseManager) throws {
        let projects = [
            Project(id: "/Users/demo/sources/nimbalyst", name: "nimbalyst", sessionCount: 0, sortOrder: 0),
            Project(id: "/Users/demo/sources/api-server", name: "api-server", sessionCount: 0, sortOrder: 1),
            Project(id: "/Users/demo/sources/design-system", name: "design-system", sessionCount: 0, sortOrder: 2),
            Project(id: "/Users/demo/sources/mobile-app", name: "mobile-app", sessionCount: 0, sortOrder: 3),
        ]
        for project in projects {
            try db.upsertProject(project)
        }
    }

    // MARK: - Sessions

    private static func insertSessions(_ db: DatabaseManager) throws {
        let now = currentEpochMs()
        let hour: Int = 3_600_000
        let day: Int = 86_400_000

        // nimbalyst project sessions
        let nimbalystSessions: [Session] = [
            // Today
            Session(
                id: "sess-nim-1",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Implement dark mode theme switching",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                contextTokens: 42_000,
                contextWindow: 100_000,
                createdAt: now - 2 * hour,
                updatedAt: now - 30 * 60_000,
                lastReadAt: now - 2 * hour,
                lastMessageAt: now - 30 * 60_000
            ),
            Session(
                id: "sess-nim-2",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Fix authentication token refresh",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                isExecuting: true,
                contextTokens: 18_000,
                contextWindow: 100_000,
                createdAt: now - 1 * hour,
                updatedAt: now - 5 * 60_000
            ),
            // Yesterday
            Session(
                id: "sess-nim-3",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Add search to session history",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                contextTokens: 78_000,
                contextWindow: 100_000,
                createdAt: now - 1 * day - 3 * hour,
                updatedAt: now - 1 * day - 1 * hour,
                lastReadAt: now - 1 * day - 2 * hour,
                lastMessageAt: now - 1 * day - 1 * hour
            ),
            Session(
                id: "sess-nim-4",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Refactor database migrations",
                provider: "claude-code",
                model: "claude-opus-4-6",
                mode: "agent",
                createdAt: now - 1 * day - 6 * hour,
                updatedAt: now - 1 * day - 4 * hour
            ),
            // This Week
            Session(
                id: "sess-nim-5",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Write unit tests for sync protocol",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "planning",
                contextTokens: 91_000,
                contextWindow: 100_000,
                createdAt: now - 3 * day,
                updatedAt: now - 3 * day + 2 * hour
            ),
            Session(
                id: "sess-nim-6",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Update README documentation",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 4 * day,
                updatedAt: now - 4 * day + 1 * hour
            ),
            // Older
            Session(
                id: "sess-nim-7",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Design extension API architecture",
                provider: "claude-code",
                model: "claude-opus-4-6",
                mode: "agent",
                createdAt: now - 10 * day,
                updatedAt: now - 10 * day + 3 * hour
            ),
            Session(
                id: "sess-nim-8",
                projectId: "/Users/demo/sources/nimbalyst",
                titleDecrypted: "Performance optimization for file watcher",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 14 * day,
                updatedAt: now - 14 * day + 2 * hour
            ),
        ]

        // api-server project sessions
        let apiSessions: [Session] = [
            Session(
                id: "sess-api-1",
                projectId: "/Users/demo/sources/api-server",
                titleDecrypted: "Add rate limiting middleware",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                contextTokens: 35_000,
                contextWindow: 100_000,
                createdAt: now - 3 * hour,
                updatedAt: now - 1 * hour,
                lastReadAt: now - 2 * hour,
                lastMessageAt: now - 1 * hour
            ),
            Session(
                id: "sess-api-2",
                projectId: "/Users/demo/sources/api-server",
                titleDecrypted: "Implement WebSocket authentication",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 1 * day - 2 * hour,
                updatedAt: now - 1 * day
            ),
            Session(
                id: "sess-api-3",
                projectId: "/Users/demo/sources/api-server",
                titleDecrypted: "Fix CORS headers for production",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 2 * day,
                updatedAt: now - 2 * day + 1 * hour
            ),
            Session(
                id: "sess-api-4",
                projectId: "/Users/demo/sources/api-server",
                titleDecrypted: "Database connection pooling setup",
                provider: "claude-code",
                model: "claude-opus-4-6",
                mode: "agent",
                hasQueuedPrompts: true,
                createdAt: now - 5 * day,
                updatedAt: now - 5 * day + 2 * hour
            ),
            Session(
                id: "sess-api-5",
                projectId: "/Users/demo/sources/api-server",
                titleDecrypted: "Add health check endpoint",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 8 * day,
                updatedAt: now - 8 * day + 1 * hour
            ),
        ]

        // design-system project sessions
        let designSessions: [Session] = [
            Session(
                id: "sess-ds-1",
                projectId: "/Users/demo/sources/design-system",
                titleDecrypted: "Create color token system",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 2 * day,
                updatedAt: now - 2 * day + 3 * hour
            ),
            Session(
                id: "sess-ds-2",
                projectId: "/Users/demo/sources/design-system",
                titleDecrypted: "Build button component variants",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 5 * day,
                updatedAt: now - 5 * day + 2 * hour
            ),
            Session(
                id: "sess-ds-3",
                projectId: "/Users/demo/sources/design-system",
                titleDecrypted: "Typography scale documentation",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 12 * day,
                updatedAt: now - 12 * day + 1 * hour
            ),
        ]

        // mobile-app project sessions
        let mobileSessions: [Session] = [
            Session(
                id: "sess-mob-1",
                projectId: "/Users/demo/sources/mobile-app",
                titleDecrypted: "Implement push notification handling",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 1 * day,
                updatedAt: now - 1 * day + 2 * hour
            ),
            Session(
                id: "sess-mob-2",
                projectId: "/Users/demo/sources/mobile-app",
                titleDecrypted: "Add offline data caching",
                provider: "claude-code",
                model: "claude-sonnet-4-5-20250929",
                mode: "agent",
                createdAt: now - 7 * day,
                updatedAt: now - 7 * day + 1 * hour
            ),
        ]

        let allSessions = nimbalystSessions + apiSessions + designSessions + mobileSessions
        for session in allSessions {
            try db.upsertSession(session)
        }
    }

    // MARK: - Messages (for showcase session)

    private static func insertMessages(_ db: DatabaseManager) throws {
        let now = currentEpochMs()
        let minute: Int = 60_000

        // Messages for "Implement dark mode theme switching" (sess-nim-1)
        let messages: [Message] = [
            // User prompt
            Message(
                id: "msg-1",
                sessionId: "sess-nim-1",
                sequence: 1,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(prompt: "Help me implement a dark mode theme switching feature. I want a toggle in settings that persists the user's preference and updates all colors instantly."),
                createdAt: now - 120 * minute
            ),
            // Assistant response with code
            Message(
                id: "msg-2",
                sessionId: "sess-nim-1",
                sequence: 2,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(text: """
                I'll implement dark mode theme switching with a `ThemeManager` that persists the preference and broadcasts changes. Here's my plan:

                1. Create a `ThemeManager` class with `@AppStorage` for persistence
                2. Define color tokens for both light and dark themes
                3. Add a toggle to the settings view
                4. Apply the theme using `.preferredColorScheme()`

                Let me start by creating the ThemeManager.
                """),
                createdAt: now - 119 * minute
            ),
            // Tool use - write file
            Message(
                id: "msg-3",
                sessionId: "sess-nim-1",
                sequence: 3,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelopeToolUse(
                    toolName: "Write",
                    input: "{\"file_path\":\"Sources/Theme/ThemeManager.swift\",\"content\":\"import SwiftUI\\n\\n@MainActor\\nfinal class ThemeManager: ObservableObject {\\n    @AppStorage(\\\"isDarkMode\\\") var isDarkMode = true\\n    \\n    var colorScheme: ColorScheme {\\n        isDarkMode ? .dark : .light\\n    }\\n    \\n    // Color tokens\\n    var background: Color { isDarkMode ? Color(hex: 0x1A1A1A) : .white }\\n    var text: Color { isDarkMode ? .white : Color(hex: 0x1A1A1A) }\\n    var accent: Color { Color(hex: 0x60A5FA) }\\n}\"}"
                ),
                createdAt: now - 118 * minute
            ),
            // Tool result
            Message(
                id: "msg-4",
                sessionId: "sess-nim-1",
                sequence: 4,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelopeToolResult(toolUseId: "msg-3", content: "File written: Sources/Theme/ThemeManager.swift"),
                createdAt: now - 118 * minute + 500
            ),
            // Assistant continuation
            Message(
                id: "msg-5",
                sessionId: "sess-nim-1",
                sequence: 5,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(text: """
                I've created the `ThemeManager` with:

                - **`@AppStorage`** for automatic persistence of the dark mode preference
                - **Color tokens** that switch based on the current theme
                - **`colorScheme`** computed property for SwiftUI's `.preferredColorScheme()` modifier

                Now let me add the toggle to your settings view.
                """),
                createdAt: now - 117 * minute
            ),
            // User follow-up
            Message(
                id: "msg-6",
                sessionId: "sess-nim-1",
                sequence: 6,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(prompt: "Can you also add a system default option, so it follows the device setting?"),
                createdAt: now - 60 * minute
            ),
            // Assistant response
            Message(
                id: "msg-7",
                sessionId: "sess-nim-1",
                sequence: 7,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(text: """
                I'll update the ThemeManager to support three modes: Light, Dark, and System. The system option will use `@Environment(\\.colorScheme)` to follow the device setting.

                ```swift
                enum ThemeMode: String, CaseIterable {
                    case system = "System"
                    case light = "Light"
                    case dark = "Dark"
                }

                @MainActor
                final class ThemeManager: ObservableObject {
                    @AppStorage("themeMode") var themeMode: ThemeMode = .system

                    var preferredColorScheme: ColorScheme? {
                        switch themeMode {
                        case .system: return nil  // follows device
                        case .light: return .light
                        case .dark: return .dark
                        }
                    }
                }
                ```

                The `nil` return for `.system` tells SwiftUI to use the device's current appearance. I'll update the settings toggle to a picker with all three options.
                """),
                createdAt: now - 58 * minute
            ),
        ]

        for message in messages {
            try db.appendMessage(message)
        }
    }

    // MARK: - Helpers

    private static func currentEpochMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    /// Wrap a user prompt in the sync envelope format.
    private static func envelope(prompt: String) -> String {
        let inner = "{\"prompt\":\(jsonString(prompt))}"
        return envelopeRaw(inner)
    }

    /// Wrap assistant text in the sync envelope format.
    private static func envelope(text: String) -> String {
        let inner = "{\"type\":\"text\",\"content\":\(jsonString(text))}"
        return envelopeRaw(inner)
    }

    /// Wrap a tool_use call in the sync envelope format.
    private static func envelopeToolUse(toolName: String, input: String) -> String {
        let inner = "{\"type\":\"tool_use\",\"id\":\"toolu_screenshot_\(toolName.lowercased())\",\"name\":\(jsonString(toolName)),\"input\":\(input)}"
        return envelopeRaw(inner)
    }

    /// Wrap a tool_result in the sync envelope format.
    private static func envelopeToolResult(toolUseId: String, content: String) -> String {
        let inner = "{\"type\":\"tool_result\",\"tool_use_id\":\(jsonString(toolUseId)),\"content\":\(jsonString(content))}"
        return envelopeRaw(inner)
    }

    /// Create the outer envelope: {"content":"<inner>","metadata":null,"hidden":false}
    private static func envelopeRaw(_ innerJson: String) -> String {
        let obj: [String: Any] = ["content": innerJson, "metadata": NSNull(), "hidden": false]
        let data = try! JSONSerialization.data(withJSONObject: obj)
        return String(data: data, encoding: .utf8)!
    }

    /// JSON-encode a string value (with proper escaping).
    /// Wraps in an array to satisfy JSONSerialization, then extracts the string element.
    private static func jsonString(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        let str = String(data: data, encoding: .utf8)!
        // Result is like: ["the escaped string"]
        // Strip the leading [ and trailing ]
        let start = str.index(after: str.startIndex)
        let end = str.index(before: str.endIndex)
        return String(str[start..<end])
    }
}
#endif
