#if canImport(UIKit)
import UIKit
import WebKit
import os

/// Pre-warms a WKWebView with the transcript HTML so that navigating to
/// SessionDetailView is instant. The web view is created and loaded in the
/// background on app launch; when SessionDetailView needs one, it takes the
/// pre-warmed instance from the pool (or creates a new one if none available).
///
/// WKWebView must be created on the main thread, but the HTML/JS loading
/// happens asynchronously in the WebKit content process.
@MainActor
public final class TranscriptWebViewPool {
    public static let shared = TranscriptWebViewPool()

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "TranscriptWebViewPool")

    /// A pre-warmed web view waiting to be claimed.
    private var warmWebView: WKWebView?

    /// Whether the pre-warmed web view has finished loading its HTML+JS.
    private var isWarm = false

    /// Whether the content process has been terminated (webview is dead).
    private var isContentProcessDead = false

    /// Callback for when the warm web view finishes loading.
    private var onWarm: (() -> Void)?

    /// Navigation delegate that detects when the warm web view finishes loading.
    private var warmupDelegate: WarmupNavigationDelegate?

    private let warmupStartTime = CFAbsoluteTimeGetCurrent()

    private init() {}

    // MARK: - Public API

    /// Begin pre-warming a WKWebView. Call this as early as possible (e.g. at app launch).
    /// Must be called on the main thread.
    public func warmup() {
        guard warmWebView == nil else {
            logger.info("warmup() called but web view already exists")
            return
        }

        logger.info("Starting web view warmup")

        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()

        // Inject error handler (same as TranscriptWebView)
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
                window.webkit.messageHandlers.bridge.postMessage({
                    type: 'js_error',
                    message: msg,
                    url: url,
                    line: line,
                    col: col,
                    stack: error ? error.stack : ''
                });
            };
            window.addEventListener('unhandledrejection', function(e) {
                window.webkit.messageHandlers.bridge.postMessage({
                    type: 'js_error',
                    message: 'Unhandled promise rejection: ' + e.reason
                });
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(errorScript)

        // DEBUG-only flag so the JS bundle can opt into diagnostic helpers
        // (window.nimbalyst._debugRaw / _debugView). Mirrors the cold-start
        // path in TranscriptWebView; both must inject it because either web
        // view may end up serving the transcript.
        #if DEBUG
        let debugFlagScript = WKUserScript(
            source: "window.__nimbalystDebug = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(debugFlagScript)
        #endif

        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x1a/255, green: 0x1a/255, blue: 0x1a/255, alpha: 1)
        webView.scrollView.backgroundColor = UIColor(red: 0x1a/255, green: 0x1a/255, blue: 0x1a/255, alpha: 1)
        webView.scrollView.bounces = false

        // Match TranscriptWebView: enable Safari Web Inspector in DEBUG. The
        // pool path is used in nearly all cases, so without this the transcript
        // shows up as "No inspectable contents" in Safari Develop menu.
        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif

        // Set up navigation delegate to detect load completion
        let delegate = WarmupNavigationDelegate { [weak self] in
            self?.logger.info("Web view warmup complete")
            self?.isWarm = true
            self?.onWarm?()
            self?.onWarm = nil
        }
        warmupDelegate = delegate
        webView.navigationDelegate = delegate

        warmWebView = webView

        // Load transcript HTML
        let bundleURL = Bundle.main.bundleURL
        let distURL = bundleURL.appendingPathComponent("transcript-dist")
        let htmlURL = distURL.appendingPathComponent("transcript.html")

        if FileManager.default.fileExists(atPath: htmlURL.path) {
            webView.loadFileURL(htmlURL, allowingReadAccessTo: distURL)
        } else {
            logger.warning("transcript.html not found, warmup skipped")
        }
    }

    /// Take the pre-warmed web view. Returns nil if none available or if the
    /// content process has been terminated (caller should create its own).
    /// After calling this, the pool is empty until `warmup()` is called again.
    public func takeWebView() -> WKWebView? {
        guard let webView = warmWebView else { return nil }

        // Don't hand out a dead webview - the content process was killed
        // (e.g., by GPU process idle exit). Caller will create a fresh one.
        if isContentProcessDead {
            logger.warning("Discarding pre-warmed web view: content process was terminated")
            discardWarmWebView()
            return nil
        }

        warmWebView = nil
        warmupDelegate = nil
        isWarm = false
        isContentProcessDead = false
        onWarm = nil
        return webView
    }

    /// Return a live transcript web view to the pool instead of tearing it down.
    /// Reusing the existing WebKit content process avoids a noticeable main-thread
    /// stall during SessionDetail back navigation on iPhone.
    public func returnWebView(_ webView: WKWebView) {
        if isContentProcessDead {
            logger.warning("Discarding returned web view: content process was terminated")
            discardWarmWebView()
            return
        }

        guard warmWebView == nil else { return }

        let delegate = WarmupNavigationDelegate { [weak self] in
            self?.isWarm = true
        }
        warmupDelegate = delegate

        webView.navigationDelegate = delegate
        webView.uiDelegate = nil
        webView.frame = CGRect(x: 0, y: 0, width: 1, height: 1)

        warmWebView = webView
        isWarm = true
        isContentProcessDead = false
        onWarm = nil
    }

    /// Whether a pre-warmed web view is available.
    public var hasWarmWebView: Bool {
        warmWebView != nil
    }

    /// Whether the pre-warmed web view has finished loading HTML+JS.
    public var isWebViewWarm: Bool {
        isWarm
    }

    /// Mark the content process as dead. Called from the navigation delegate
    /// when the content process terminates. This is safe to call from any context
    /// since it just sets a flag that `takeWebView()` checks.
    func markContentProcessDead() {
        isContentProcessDead = true
    }

    /// Discard the pooled web view (e.g. if its content process crashed).
    func discardWarmWebView() {
        warmWebView = nil
        warmupDelegate = nil
        isWarm = false
        isContentProcessDead = false
        onWarm = nil
    }
}

// MARK: - Warmup Navigation Delegate

/// Lightweight delegate that fires a callback when the page finishes loading
/// and discards the pooled WebView if the content process terminates.
private class WarmupNavigationDelegate: NSObject, WKNavigationDelegate {
    private let onFinish: () -> Void

    init(onFinish: @escaping () -> Void) {
        self.onFinish = onFinish
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onFinish()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        // Warmup navigation failed - pool will be empty, cold-start path used instead
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        // Warmup provisional navigation failed
    }

    func webView(_ webView: WKWebView, webContentProcessDidTerminate: WKWebView) {
        // WKNavigationDelegate is called on the main thread.
        // Use MainActor.assumeIsolated to call @MainActor methods synchronously,
        // avoiding the Task race where takeWebView() could run before the cleanup.
        MainActor.assumeIsolated {
            TranscriptWebViewPool.shared.markContentProcessDead()
            TranscriptWebViewPool.shared.discardWarmWebView()
        }
    }
}
#endif
