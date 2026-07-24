#if canImport(UIKit)
import SwiftUI
import WebKit
import os

/// Container view for editing a synced markdown document.
/// Wraps a WKWebView that loads the mobile Lexical editor bundle.
///
/// Bridge protocol:
///   Swift -> JS: `window.nimbalystEditor.loadMarkdown(content)`
///                `window.nimbalystEditor.setReadOnly(boolean)`
///   JS -> Swift: `webkit.messageHandlers.editorBridge.postMessage({ type, ... })`
public struct DocumentEditorView: View {
    @EnvironmentObject var appState: AppState
    let document: SyncedDocument

    @State private var isLoading = true
    @State private var isDirty = false
    @State private var errorMessage: String?
    @State private var editorWebView: WKWebView?

    /// Document with content resolved (decrypted on demand if needed).
    private var resolvedDocument: SyncedDocument {
        if document.contentDecrypted != nil {
            return document
        }
        // Try on-demand decryption for bulk-synced documents
        if let content = appState.documentSyncManager?.decryptContentOnDemand(document) {
            var resolved = document
            resolved.contentDecrypted = content
            return resolved
        }
        return document
    }

    public var body: some View {
        ZStack {
            EditorWebView(
                document: resolvedDocument,
                onReady: {
                    isLoading = false
                    errorMessage = nil
                },
                onContentChanged: handleContentChanged,
                onDirtyChanged: { isDirty = $0 },
                onError: { errorMessage = $0 },
                onWebViewCreated: { editorWebView = $0 }
            )
            .ignoresSafeArea(.container, edges: .bottom)

            if isLoading {
                ProgressView("Loading editor...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(hex: 0x1a1a1a))
            }

            if let error = errorMessage {
                VStack {
                    Spacer()

                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.title2)
                            .foregroundStyle(.orange)

                        Text("Editor Error")
                            .font(.headline)
                            .foregroundStyle(.primary)

                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)

                        HStack(spacing: 12) {
                            Button {
                                copyError(error)
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                            .buttonStyle(.bordered)

                            Button {
                                errorMessage = nil
                            } label: {
                                Label("Dismiss", systemImage: "xmark")
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(NimbalystColors.primary)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: 420)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .stroke(Color.white.opacity(0.12), lineWidth: 1)
                    )
                    .padding(.horizontal, 16)
                    .padding(.bottom, 20)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(document.displayName)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if isDirty {
                ToolbarItem(placement: .primaryAction) {
                    Circle()
                        .fill(NimbalystColors.primary)
                        .frame(width: 8, height: 8)
                }
            }
        }
        .onAppear {
            subscribeToRemoteUpdates()
        }
        .onDisappear {
            unsubscribeFromRemoteUpdates()
        }
    }

    private func handleContentChanged(_ markdown: String) {
        // Encrypt and push to ProjectSyncRoom via DocumentSyncManager
        appState.documentSyncManager?.pushEditedContent(
            document: document,
            markdown: markdown,
            projectId: document.projectId
        )
    }

    private func copyError(_ error: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = [
            "Document Editor Error",
            "=====================",
            "Document: \(document.displayName)",
            "Document ID: \(document.id)",
            "",
            error,
        ].joined(separator: "\n")
        #endif
    }

    /// Subscribe to remote content updates for this document's syncId.
    private func subscribeToRemoteUpdates() {
        let syncId = document.id
        appState.documentSyncManager?.onRemoteContentUpdate = { [syncId] remoteSyncId, newMarkdown in
            guard remoteSyncId == syncId, let webView = editorWebView else { return }

            // Update the editor content via the JS bridge
            let escaped = newMarkdown
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
                .replacingOccurrences(of: "\t", with: "\\t")
            let js = "window.nimbalystEditor.loadMarkdown(\"\(escaped)\")"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func unsubscribeFromRemoteUpdates() {
        appState.documentSyncManager?.onRemoteContentUpdate = nil
    }
}

// MARK: - FormattingWebView (adds Bold/Italic/Code to native edit menu)

class FormattingWebView: WKWebView {
    private func formatText(_ format: String) {
        evaluateJavaScript("window.nimbalystEditor.formatText('\(format)')", completionHandler: nil)
    }

    @objc private func formatBold() { formatText("bold") }
    @objc private func formatItalic() { formatText("italic") }
    @objc private func formatCode() { formatText("code") }
    @objc private func formatStrikethrough() { formatText("strikethrough") }

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)

        let formatActions = [
            UIAction(title: "Bold", image: UIImage(systemName: "bold")) { [weak self] _ in
                self?.formatBold()
            },
            UIAction(title: "Italic", image: UIImage(systemName: "italic")) { [weak self] _ in
                self?.formatItalic()
            },
            UIAction(title: "Code", image: UIImage(systemName: "chevron.left.forwardslash.chevron.right")) { [weak self] _ in
                self?.formatCode()
            },
            UIAction(title: "Strikethrough", image: UIImage(systemName: "strikethrough")) { [weak self] _ in
                self?.formatStrikethrough()
            },
        ]

        let formatMenu = UIMenu(title: "", options: .displayInline, children: formatActions)
        builder.insertSibling(formatMenu, afterMenu: .standardEdit)
    }
}

// MARK: - Editor Web View (UIViewRepresentable)

struct EditorWebView: UIViewRepresentable {
    let document: SyncedDocument
    let onReady: () -> Void
    let onContentChanged: (String) -> Void
    let onDirtyChanged: (Bool) -> Void
    let onError: (String) -> Void
    let onWebViewCreated: (WKWebView) -> Void

    private static let logger = Logger(subsystem: "com.nimbalyst.app", category: "EditorWebView")

    func makeCoordinator() -> Coordinator {
        Coordinator(
            document: document,
            onReady: onReady,
            onContentChanged: onContentChanged,
            onDirtyChanged: onDirtyChanged,
            onError: onError
        )
    }

    func makeUIView(context: Context) -> FormattingWebView {
        let config = WKWebViewConfiguration()

        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "editorBridge")

        // Inject error handler
        let errorScript = WKUserScript(
            source: """
            function isBenignWindowErrorMessage(message) {
                return message === 'ResizeObserver loop completed with undelivered notifications.';
            }
            window.onerror = function(msg, url, line, col, error) {
                var messageText = error && error.message ? error.message : String(msg);
                if (isBenignWindowErrorMessage(messageText)) {
                    return true;
                }
                window.webkit.messageHandlers.editorBridge.postMessage({
                    type: 'error',
                    message: msg + ' at ' + url + ':' + line + ':' + col,
                    stack: error ? error.stack : ''
                });
            };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(errorScript)

        config.userContentController = contentController
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let webView = FormattingWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
        webView.scrollView.backgroundColor = UIColor(red: 0.1, green: 0.1, blue: 0.1, alpha: 1)
        webView.scrollView.keyboardDismissMode = .interactive
        webView.allowsBackForwardNavigationGestures = false

        context.coordinator.webView = webView
        DispatchQueue.main.async {
            onWebViewCreated(webView)
        }

        // Load the editor HTML from the bundle
        if let editorURL = Bundle.main.url(forResource: "editor", withExtension: "html", subdirectory: "editor-dist") {
            let dirURL = editorURL.deletingLastPathComponent()
            webView.loadFileURL(editorURL, allowingReadAccessTo: dirURL)
        } else {
            Self.logger.error("Editor bundle not found in app bundle")
            onError("Editor bundle not found. Rebuild the app.")
        }

        return webView
    }

    func updateUIView(_ webView: FormattingWebView, context: Context) {
        // Content updates are handled via the bridge, not SwiftUI re-renders
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private let logger = Logger(subsystem: "com.nimbalyst.app", category: "EditorCoordinator")

        let document: SyncedDocument
        let onReady: () -> Void
        let onContentChanged: (String) -> Void
        let onDirtyChanged: (Bool) -> Void
        let onError: (String) -> Void
        weak var webView: WKWebView?
        private var hasLoadedContent = false

        init(
            document: SyncedDocument,
            onReady: @escaping () -> Void,
            onContentChanged: @escaping (String) -> Void,
            onDirtyChanged: @escaping (Bool) -> Void,
            onError: @escaping (String) -> Void
        ) {
            self.document = document
            self.onReady = onReady
            self.onContentChanged = onContentChanged
            self.onDirtyChanged = onDirtyChanged
            self.onError = onError
        }

        // MARK: - WKScriptMessageHandler

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else { return }

            switch type {
            case "editorReady":
                logger.info("Editor ready, loading content")
                loadContent()
                onReady()

            case "contentChanged":
                if let markdown = body["content"] as? String {
                    onContentChanged(markdown)
                }

            case "dirty":
                if let isDirty = body["isDirty"] as? Bool {
                    DispatchQueue.main.async { [weak self] in
                        self?.onDirtyChanged(isDirty)
                    }
                }

            case "error":
                let errorMsg = body["message"] as? String ?? "Unknown editor error"
                if errorMsg.contains("ResizeObserver loop completed with undelivered notifications.") {
                    return
                }
                logger.error("Editor error: \(errorMsg)")
                DispatchQueue.main.async { [weak self] in
                    self?.onError(errorMsg)
                }

            default:
                break
            }
        }

        // MARK: - WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            logger.info("Editor HTML loaded")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            logger.error("Editor navigation failed: \(error.localizedDescription)")
            DispatchQueue.main.async { [weak self] in
                self?.onError("Failed to load editor: \(error.localizedDescription)")
            }
        }

        // MARK: - Content Loading

        private func loadContent() {
            guard !hasLoadedContent else { return }
            hasLoadedContent = true

            let content = document.contentDecrypted ?? ""
            // Escape for JS string
            let escaped = content
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
                .replacingOccurrences(of: "\t", with: "\\t")

            let js = "window.nimbalystEditor.loadMarkdown(\"\(escaped)\")"
            webView?.evaluateJavaScript(js) { [weak self] _, error in
                if let error = error {
                    self?.logger.error("Failed to load markdown: \(error.localizedDescription)")
                }
            }
        }
    }
}

#endif
