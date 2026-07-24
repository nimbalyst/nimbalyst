#if DEBUG
import Foundation

extension AppState {
    /// Add mock session data for testing the transcript view.
    /// Call this after pairing to populate the database with test data.
    ///
    /// Messages use the real encrypted envelope format: {"content":"<inner JSON>","metadata":null,"hidden":false}
    /// This matches what SyncManager stores after decrypting messages from the server.
    public func addMockTranscriptSession() async throws {
        guard let db = databaseManager else {
            print("[AppState] Cannot add mock data: database not initialized")
            return
        }

        // Create test project
        let project = Project(
            id: "/test/transcript",
            name: "Transcript Test Project",
            sessionCount: 1
        )
        try db.upsertProject(project)

        // Create test session
        let session = Session(
            id: "transcript-test-session",
            projectId: "/test/transcript",
            titleDecrypted: "Transcript Rendering Test",
            provider: "claude-code",
            model: "claude-sonnet-4",
            mode: "agent",
            createdAt: Int(Date().timeIntervalSince1970) - 3600, // 1 hour ago
            updatedAt: Int(Date().timeIntervalSince1970)
        )
        try db.upsertSession(session)

        // Helper to wrap content in the sync envelope format.
        // Real decrypted messages are: {"content":"<inner JSON string>","metadata":null,"hidden":false}
        // The inner content is a JSON string VALUE (escaped), not a nested object.
        func envelope(_ innerContent: String, hidden: Bool = false) -> String {
            let obj: [String: Any] = [
                "content": innerContent,
                "metadata": NSNull(),
                "hidden": hidden,
            ]
            let data = try! JSONSerialization.data(withJSONObject: obj)
            return String(data: data, encoding: .utf8)!
        }

        // Add test messages with various content types, wrapped in envelope format
        let messages: [Message] = [
            // User message (input direction, prompt format)
            Message(
                id: "msg-1",
                sessionId: "transcript-test-session",
                sequence: 1,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(#"{"prompt":"Create a simple hello world function and explain how it works"}"#),
                createdAt: Int(Date().timeIntervalSince1970) - 3500
            ),

            // Text response (output direction, text chunk format)
            Message(
                id: "msg-2",
                sessionId: "transcript-test-session",
                sequence: 2,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(#"{"type":"text","content":"I'll create a simple hello world function for you and explain how it works."}"#),
                createdAt: Int(Date().timeIntervalSince1970) - 3480
            ),

            // Tool use - assistant message with tool_use block
            Message(
                id: "msg-3",
                sessionId: "transcript-test-session",
                sequence: 3,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-write-1","name":"Write","input":{"file_path":"/test/hello.js","content":"/**\n * A simple hello world function\n */\nfunction hello(name = 'World') {\n  console.log(`Hello, ${name}!`);\n  return `Greeted ${name}`;\n}\n\nhello();\nhello('Nimbalyst');"}}]}}"#),
                createdAt: Int(Date().timeIntervalSince1970) - 3460
            ),

            // Tool result (input direction, user message with tool_result)
            Message(
                id: "msg-4",
                sessionId: "transcript-test-session",
                sequence: 4,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-write-1","content":[{"type":"text","text":"File written successfully"}]}]}}"#),
                createdAt: Int(Date().timeIntervalSince1970) - 3440
            ),

            // Explanation text
            Message(
                id: "msg-5",
                sessionId: "transcript-test-session",
                sequence: 5,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(#"{"type":"text","content":"I've created a hello world function with the following features:\n\n**Function Breakdown:**\n\n1. **Default Parameter** - `name = 'World'` provides a fallback value\n2. **Template Literal** - Uses backticks for string interpolation\n3. **Return Value** - Returns a confirmation message\n\nYou can run this with:\n```bash\nnode /test/hello.js\n```"}"#),
                createdAt: Int(Date().timeIntervalSince1970) - 3420
            ),

            // Follow-up user message
            Message(
                id: "msg-6",
                sessionId: "transcript-test-session",
                sequence: 6,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(#"{"prompt":"Can you add error handling?"}"#),
                createdAt: Int(Date().timeIntervalSince1970) - 3400
            ),

            // Tool use - Edit file
            Message(
                id: "msg-7",
                sessionId: "transcript-test-session",
                sequence: 7,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: envelope(#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll add input validation and error handling."},{"type":"tool_use","id":"tool-edit-1","name":"Edit","input":{"file_path":"/test/hello.js","old_string":"function hello(name = 'World') {","new_string":"function hello(name = 'World') {\n  if (typeof name !== 'string') {\n    throw new TypeError('Name must be a string');\n  }"}}]}}"#),
                createdAt: Int(Date().timeIntervalSince1970) - 3380
            )
        ]

        try db.appendMessages(messages)

        print("[AppState] Mock transcript session created successfully")
        print("[AppState] - Project: \(project.name)")
        print("[AppState] - Session: \(session.titleDecrypted ?? "Untitled")")
        print("[AppState] - Messages: \(messages.count)")
    }
}
#endif
