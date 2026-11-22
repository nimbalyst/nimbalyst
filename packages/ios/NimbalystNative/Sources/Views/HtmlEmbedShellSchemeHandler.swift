#if canImport(UIKit)
import Foundation
import WebKit

/// Serves the HTML embed sandbox shell at `nimbalyst-embed://shell` for the
/// document editor, with its Content-Security-Policy as a response header (a
/// `<meta>` CSP cannot carry the `sandbox` directive). Both files come from the
/// editor bundle build (`vite.config.editor.ts`), generated from the shell in
/// `@nimbalyst/collab-protocol` that desktop and the web console serve.
final class HtmlEmbedShellSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "nimbalyst-embed"

    private static let shell: (html: Data, csp: String)? = {
        guard let htmlURL = Bundle.main.url(forResource: "html-embed-shell", withExtension: "html", subdirectory: "editor-dist"),
              let cspURL = Bundle.main.url(forResource: "html-embed-shell", withExtension: "csp", subdirectory: "editor-dist"),
              let html = try? Data(contentsOf: htmlURL),
              let csp = try? String(contentsOf: cspURL, encoding: .utf8) else { return nil }
        return (html, csp.trimmingCharacters(in: .whitespacesAndNewlines))
    }()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.host == "shell", let shell = Self.shell,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                  "Content-Type": "text/html; charset=utf-8",
                  "Content-Security-Policy": shell.csp,
                  "Cache-Control": "no-store",
              ]) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(shell.html)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
#endif
