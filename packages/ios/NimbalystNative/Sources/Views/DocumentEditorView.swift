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
///
/// The bundle only reports user edits (a load never echoes back as a save), and
/// a remote update is not loaded over edits that have not been saved yet; the
/// next save wins, as on Android.
public struct DocumentEditorView: View {
    @EnvironmentObject var appState: AppState
    let document: SyncedDocument
    let readOnly: Bool
    let header: AnyView?
    /// Handles a tapped link; return false to fall through to web links.
    let onLink: ((_ href: String, _ title: String?) -> Bool)?

    @State private var isLoading = true
    @StateObject private var edits = DocumentEditState()
    @State private var errorMessage: String?
    @State private var editorWebView: WKWebView?
    @Environment(\.scenePhase) private var scenePhase

    public init(document: SyncedDocument, readOnly: Bool = false, header: AnyView? = nil, onLink: ((_ href: String, _ title: String?) -> Bool)? = nil) {
        self.document = document
        self.readOnly = readOnly
        self.header = header
        self.onLink = onLink
    }

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
            VStack(spacing: 0) {
                if let header { header }
                EditorWebView(
                    document: resolvedDocument,
                    readOnly: readOnly,
                    onReady: {
                        isLoading = false
                        errorMessage = nil
                    },
                    onContentChanged: handleContentChanged,
                    onDirtyChanged: { edits.isDirty = $0 },
                    onLinkTapped: handleLink,
                    onError: { errorMessage = $0 },
                    onWebViewCreated: { editorWebView = $0 }
                )
                .ignoresSafeArea(.container, edges: .bottom)
            }

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
            if edits.isDirty {
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
            flushPendingSave()
            unsubscribeFromRemoteUpdates()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { flushPendingSave() }
        }
    }

    /// Saves typing still inside the bundle's 500ms debounce. The coordinator
    /// outlives this view value, so the save uses the permission and handler
    /// current when the content arrives, not the ones captured here.
    private func flushPendingSave() {
        (editorWebView as? FormattingWebView)?.coordinator?.flush()
    }

    /// Persists an edit; true once it is in the local cache and sent or queued.
    private func handleContentChanged(_ markdown: String) -> Bool {
        guard !readOnly, let manager = appState.documentSyncManager else { return false }
        // Encrypt and push to ProjectSyncRoom via DocumentSyncManager. The push
        // queues when offline and writes the local cache; it reports failure
        // only in its log, so the cache is the evidence it worked.
        manager.pushEditedContent(document: document, markdown: markdown, projectId: document.projectId)
        let stored = try? appState.databaseManager?.document(byId: document.id)
        return stored?.contentDecrypted == markdown
    }

    private func handleLink(_ href: String, _ title: String?) {
        if onLink?(href, title) == true { return }
        guard let url = URL(string: href.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(),
              ["http", "https", "mailto"].contains(scheme) else { return }
        UIApplication.shared.open(url)
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
        let edits = edits
        appState.documentSyncManager?.onRemoteContentUpdate = { [syncId] remoteSyncId, newMarkdown in
            guard remoteSyncId == syncId, let webView = editorWebView else { return }
            // Update the editor content via the JS bridge. With unsaved body
            // edits the bundle defers it: the frontmatter is taken now (the
            // phone never edits it), the body edits win on their next save
            // (last write wins), and undoing them shows the remote body.
            let escaped = newMarkdown
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
                .replacingOccurrences(of: "\t", with: "\\t")
            let call = edits.shouldLoadRemote() ? "loadMarkdown" : "deferRemote"
            // Loaded or deferred, the remote version is what the cache holds now.
            (webView as? FormattingWebView)?.coordinator?.ledger.loaded(newMarkdown)
            webView.evaluateJavaScript("window.nimbalystEditor.\(call)(\"\(escaped)\")", completionHandler: nil)
        }
    }

    private func unsubscribeFromRemoteUpdates() {
        appState.documentSyncManager?.onRemoteContentUpdate = nil
    }
}

/// Whether the open editor holds edits that have not been pushed yet.
@MainActor
final class DocumentEditState: ObservableObject {
    @Published var isDirty = false

    func shouldLoadRemote() -> Bool { !isDirty }
}

// MARK: - FormattingWebView (adds Bold/Italic/Code to native edit menu)

class FormattingWebView: WKWebView {
    /// The editor's coordinator, for saves that must outlive the SwiftUI view value.
    weak var coordinator: EditorWebView.Coordinator?

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
    var readOnly = false
    let onReady: () -> Void
    let onContentChanged: (String) -> Bool
    let onDirtyChanged: (Bool) -> Void
    var onLinkTapped: (String, String?) -> Void = { _, _ in }
    let onError: (String) -> Void
    let onWebViewCreated: (WKWebView) -> Void

    private static let logger = Logger(subsystem: "com.nimbalyst.app", category: "EditorWebView")

    func makeCoordinator() -> Coordinator {
        Coordinator(
            document: document,
            readOnly: readOnly,
            onReady: onReady,
            onContentChanged: onContentChanged,
            onDirtyChanged: onDirtyChanged,
            onLinkTapped: onLinkTapped,
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
        webView.coordinator = context.coordinator
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
        // Content updates are handled via the bridge, not SwiftUI re-renders.
        // Permission and handlers can change while the editor is open (the wiki
        // turns unsupported, a page turns malformed, links resolve against a
        // newer snapshot), so the coordinator always uses the latest ones.
        let coordinator = context.coordinator
        coordinator.onContentChanged = onContentChanged
        coordinator.onLinkTapped = onLinkTapped
        coordinator.setReadOnly(readOnly)
    }

    // MARK: - Coordinator

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private let logger = Logger(subsystem: "com.nimbalyst.app", category: "EditorCoordinator")

        let document: SyncedDocument
        private(set) var readOnly: Bool
        let onReady: () -> Void
        var onContentChanged: (String) -> Bool
        let onDirtyChanged: (Bool) -> Void
        var onLinkTapped: (String, String?) -> Void
        let onError: (String) -> Void
        weak var webView: WKWebView?
        private var hasLoadedContent = false
        var ledger = EditorSaveLedger()

        init(
            document: SyncedDocument,
            readOnly: Bool,
            onReady: @escaping () -> Void,
            onContentChanged: @escaping (String) -> Bool,
            onDirtyChanged: @escaping (Bool) -> Void,
            onLinkTapped: @escaping (String, String?) -> Void,
            onError: @escaping (String) -> Void
        ) {
            self.document = document
            self.readOnly = readOnly
            self.onReady = onReady
            self.onContentChanged = onContentChanged
            self.onDirtyChanged = onDirtyChanged
            self.onLinkTapped = onLinkTapped
            self.onError = onError
        }

        /// Saves with the permission and handler current now (they follow the
        /// view through `updateUIView`), then tells the bundle the outcome.
        func persist(_ markdown: String, revision: Int?) {
            // A teardown save of text native already wrote must not overwrite a
            // remote version persisted since.
            guard ledger.shouldPersist(markdown, revision: revision) else { return }
            let ok = !readOnly && onContentChanged(markdown)
            if ok { ledger.persisted(markdown) }
            if let revision {
                webView?.evaluateJavaScript("window.nimbalystEditor && window.nimbalystEditor.saveResult(\(revision), \(ok))", completionHandler: nil)
            }
        }

        /// Takes the bundle's unsaved content now (the editor is closing or the
        /// app leaving the foreground) and persists it. The completion holds the
        /// coordinator and web view, so the save and its ack finish even after
        /// SwiftUI has dropped the view.
        func flush() {
            guard !readOnly, let webView else { return }
            webView.evaluateJavaScript("window.nimbalystEditor ? window.nimbalystEditor.flush() : null") { result, _ in
                withExtendedLifetime(webView) {
                    guard let request = result as? [String: Any],
                          let markdown = request["content"] as? String else { return }
                    self.persist(markdown, revision: (request["revision"] as? NSNumber)?.intValue)
                }
            }
        }

        func setReadOnly(_ value: Bool) {
            guard value != readOnly else { return }
            readOnly = value
            if hasLoadedContent {
                webView?.evaluateJavaScript("window.nimbalystEditor.setReadOnly(\(value))", completionHandler: nil)
            }
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
                    let revision = (body["revision"] as? NSNumber)?.intValue
                    DispatchQueue.main.async { [weak self] in
                        self?.persist(markdown, revision: revision)
                    }
                }

            case "linkClicked":
                if let href = body["href"] as? String {
                    let title = body["title"] as? String
                    DispatchQueue.main.async { [weak self] in
                        self?.onLinkTapped(href, title)
                    }
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

        /// The web view only ever shows the bundled editor; links are handled
        /// through the bridge (`linkClicked`), never by navigating the editor away.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            let url = navigationAction.request.url
            if navigationAction.navigationType == .other, url?.isFileURL == true, url?.lastPathComponent == "editor.html" {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated, let url {
                let href = url.absoluteString
                DispatchQueue.main.async { [weak self] in self?.onLinkTapped(href, nil) }
            }
            decisionHandler(.cancel)
        }

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
            ledger.loaded(content)
            // Escape for JS string
            let escaped = content
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
                .replacingOccurrences(of: "\r", with: "\\r")
                .replacingOccurrences(of: "\t", with: "\\t")

            var js = "window.nimbalystEditor.loadMarkdown(\"\(escaped)\")"
            if readOnly { js += "; window.nimbalystEditor.setReadOnly(true)" }
            webView?.evaluateJavaScript(js) { [weak self] _, error in
                if let error = error {
                    self?.logger.error("Failed to load markdown: \(error.localizedDescription)")
                }
            }
        }
    }
}

#endif
