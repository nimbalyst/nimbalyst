import XCTest
import WebKit
@testable import NimbalystNative

#if canImport(UIKit)
import UIKit

/// Tests for TranscriptWebView that verify the actual web bundle loads and executes.
///
/// These tests load the real transcript HTML/JS bundle in a WKWebView and verify
/// that the JavaScript executes, window.nimbalyst is defined, and sessions render.
final class TranscriptWebViewTests: XCTestCase {
    var db: DatabaseManager!
    var session: Session!
    var messages: [Message] = []

    override func setUp() async throws {
        db = try DatabaseManager()

        let project = Project(id: "/test", name: "test")
        try db.upsertProject(project)

        session = Session(
            id: "test-session-1",
            projectId: "/test",
            titleDecrypted: "Test Session",
            provider: "claude-code",
            mode: "agent",
            createdAt: Int(Date().timeIntervalSince1970),
            updatedAt: Int(Date().timeIntervalSince1970)
        )
        try db.upsertSession(session)

        messages = [
            Message(
                id: "msg-1",
                sessionId: session.id,
                sequence: 1,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Hello\"}}",
                createdAt: Int(Date().timeIntervalSince1970)
            ),
            Message(
                id: "msg-2",
                sessionId: session.id,
                sequence: 2,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: "{\"type\":\"text\",\"text\":\"Hello! How can I help you?\"}",
                createdAt: Int(Date().timeIntervalSince1970)
            )
        ]
        try db.appendMessages(messages)
    }

    override func tearDown() async throws {
        db = nil
        session = nil
        messages = []
    }

    /// Test that the transcript HTML bundle exists in the app bundle
    func testTranscriptBundleExists() throws {
        let bundleURL = Bundle.main.bundleURL
        let distURL = bundleURL.appendingPathComponent("transcript-dist")
        let htmlURL = distURL.appendingPathComponent("transcript.html")

        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: htmlURL.path),
            "transcript.html not found - run 'npm run build:transcript' first"
        )

        let assetsURL = distURL.appendingPathComponent("assets")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: assetsURL.path),
            "assets folder should exist at \(assetsURL.path)"
        )
    }

    /// Test that the HTML does not contain crossorigin or type="module" attributes
    /// which break file:// loading in WKWebView.
    func testTranscriptHTMLHasNoModuleOrCrossorigin() throws {
        let bundleURL = Bundle.main.bundleURL
        let htmlURL = bundleURL
            .appendingPathComponent("transcript-dist")
            .appendingPathComponent("transcript.html")

        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: htmlURL.path),
            "transcript.html not found - run 'npm run build:transcript' first"
        )

        let html = try String(contentsOf: htmlURL, encoding: .utf8)

        XCTAssertFalse(
            html.contains("crossorigin"),
            "transcript.html must not contain 'crossorigin' attribute (breaks file:// CORS)"
        )
        XCTAssertFalse(
            html.contains("type=\"module\""),
            "transcript.html must not contain 'type=\"module\"' (ES modules enforce CORS on file:// URLs)"
        )
        XCTAssertTrue(
            html.contains("defer"),
            "transcript.html script tag should have 'defer' attribute for DOM-ready execution"
        )
    }

    /// Test that the JS bundle actually executes in WKWebView and defines window.nimbalyst.
    /// This is the critical rendering test - if this fails, the transcript will be blank.
    @MainActor
    func testJSBundleExecutesAndDefinesNimbalyst() async throws {
        let bundleURL = Bundle.main.bundleURL
        let distURL = bundleURL.appendingPathComponent("transcript-dist")
        let htmlURL = distURL.appendingPathComponent("transcript.html")

        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: htmlURL.path),
            "transcript.html not found - run 'npm run build:transcript' first"
        )

        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()

        // Set up bridge message handler to capture the "ready" signal
        let readyExpectation = expectation(description: "JS bridge signals ready")
        let bridgeHandler = TestBridgeHandler { message in
            if let body = message as? [String: Any],
               let type = body["type"] as? String,
               type == "ready" {
                readyExpectation.fulfill()
            }
        }
        contentController.add(bridgeHandler, name: "bridge")
        config.userContentController = contentController

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 375, height: 812), configuration: config)

        // Load the actual transcript HTML from the bundle
        webView.loadFileURL(htmlURL, allowingReadAccessTo: distURL)

        // Wait for the ready signal from JS
        await fulfillment(of: [readyExpectation], timeout: 10.0)

        // Verify window.nimbalyst is defined and has expected methods
        let nimbalystType = try await webView.evaluateJavaScript("typeof window.nimbalyst") as? String
        XCTAssertEqual(nimbalystType, "object", "window.nimbalyst should be defined after JS executes")

        let hasLoadSession = try await webView.evaluateJavaScript("typeof window.nimbalyst.loadSession") as? String
        XCTAssertEqual(hasLoadSession, "function", "window.nimbalyst.loadSession should be a function")

        let hasAppendMessage = try await webView.evaluateJavaScript("typeof window.nimbalyst.appendMessage") as? String
        XCTAssertEqual(hasAppendMessage, "function", "window.nimbalyst.appendMessage should be a function")

        // Verify the transcript root element exists and React mounted
        let rootExists = try await webView.evaluateJavaScript("!!document.getElementById('transcript-root')") as? Bool
        XCTAssertTrue(rootExists ?? false, "transcript-root element should exist")

        let rootHasContent = try await webView.evaluateJavaScript("document.getElementById('transcript-root').innerHTML.length > 0") as? Bool
        XCTAssertTrue(rootHasContent ?? false, "transcript-root should have rendered content (React mounted)")

        // Clean up
        contentController.removeScriptMessageHandler(forName: "bridge")
    }

    /// Test that loading a session into the WebView produces visible content.
    @MainActor
    func testLoadSessionRendersContent() async throws {
        let bundleURL = Bundle.main.bundleURL
        let distURL = bundleURL.appendingPathComponent("transcript-dist")
        let htmlURL = distURL.appendingPathComponent("transcript.html")

        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: htmlURL.path),
            "transcript.html not found - run 'npm run build:transcript' first"
        )

        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()

        let readyExpectation = expectation(description: "JS bridge signals ready")
        let bridgeHandler = TestBridgeHandler { message in
            if let body = message as? [String: Any],
               let type = body["type"] as? String,
               type == "ready" {
                readyExpectation.fulfill()
            }
        }
        contentController.add(bridgeHandler, name: "bridge")
        config.userContentController = contentController

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 375, height: 812), configuration: config)
        webView.loadFileURL(htmlURL, allowingReadAccessTo: distURL)

        await fulfillment(of: [readyExpectation], timeout: 10.0)

        // Load a session with test messages
        let sessionData: [String: Any] = [
            "sessionId": "test-session-1",
            "messages": [
                [
                    "id": "msg-1",
                    "sessionId": "test-session-1",
                    "sequence": 1,
                    "source": "user",
                    "direction": "input",
                    "contentDecrypted": "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Hello\"}}",
                    "createdAt": Int(Date().timeIntervalSince1970)
                ],
                [
                    "id": "msg-2",
                    "sessionId": "test-session-1",
                    "sequence": 2,
                    "source": "claude-code",
                    "direction": "output",
                    "contentDecrypted": "{\"type\":\"text\",\"text\":\"Hello! How can I help you?\"}",
                    "createdAt": Int(Date().timeIntervalSince1970)
                ]
            ],
            "metadata": [
                "title": "Test Session",
                "provider": "claude-code",
                "mode": "agent",
                "isExecuting": false
            ]
        ]

        let jsonData = try JSONSerialization.data(withJSONObject: sessionData)
        let jsonString = String(data: jsonData, encoding: .utf8)!
        let js = "window.nimbalyst.loadSession(\(jsonString));"
        try await webView.evaluateJavaScript(js)

        // Wait for React to re-render with the session data
        try await Task.sleep(nanoseconds: 1_000_000_000) // 1s for React render

        // Verify content rendered
        let rootHTML = try await webView.evaluateJavaScript(
            "document.getElementById('transcript-root').innerHTML.length"
        ) as? Int ?? 0
        XCTAssertGreaterThan(rootHTML, 100, "transcript-root should have substantial content after loading a session")

        // Clean up
        contentController.removeScriptMessageHandler(forName: "bridge")
    }

    /// Test that interactive responses are forwarded correctly
    @MainActor
    func testInteractiveResponseForwarding() async throws {
        var receivedAction: String?
        var receivedPromptId: String?
        let expectation = expectation(description: "Interactive response received")

        let coordinator = TranscriptWebView.Coordinator(
            session: session,
            waitForInitialMessages: false,
            onSendPrompt: { _ in },
            onInteractiveResponse: { action, promptId, _ in
                receivedAction = action
                receivedPromptId = promptId
                expectation.fulfill()
            }
        )

        let message = [
            "type": "interactive_response",
            "action": "exitPlanModeApprove",
            "requestId": "req-123"
        ] as [String: Any]

        coordinator.userContentController(
            WKUserContentController(),
            didReceive: MockScriptMessage(body: message)
        )

        await fulfillment(of: [expectation], timeout: 5.0)
        XCTAssertEqual(receivedAction, "exitPlanModeApprove")
        XCTAssertEqual(receivedPromptId, "req-123")
    }

    /// Test that prompt messages are forwarded correctly
    @MainActor
    func testPromptForwarding() async throws {
        var receivedPrompt: String?
        let expectation = expectation(description: "Prompt received")

        let coordinator = TranscriptWebView.Coordinator(
            session: session,
            waitForInitialMessages: false,
            onSendPrompt: { text in
                receivedPrompt = text
                expectation.fulfill()
            },
            onInteractiveResponse: { _, _, _ in }
        )

        let message = [
            "type": "prompt",
            "text": "Create a new feature"
        ] as [String: Any]

        coordinator.userContentController(
            WKUserContentController(),
            didReceive: MockScriptMessage(body: message)
        )

        await fulfillment(of: [expectation], timeout: 5.0)
        XCTAssertEqual(receivedPrompt, "Create a new feature")
    }
}

// MARK: - Test Helpers

/// Bridge message handler for tests that captures messages from JS.
class TestBridgeHandler: NSObject, WKScriptMessageHandler {
    private let handler: (Any) -> Void

    init(handler: @escaping (Any) -> Void) {
        self.handler = handler
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        handler(message.body)
    }
}

/// Mock WKScriptMessage for unit tests.
class MockScriptMessage: WKScriptMessage {
    private let _body: Any

    init(body: Any) {
        self._body = body
    }

    override var body: Any {
        return _body
    }
}

#endif
