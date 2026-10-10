import XCTest
import WebKit

/// Opt-in live check that the installed Stytch B2B SDK adopts a session minted by
/// `POST /auth/console-session` inside a real WKWebView, the way the console's
/// `/authenticate/native` does: `updateSession(tokens)`, then `authenticate()`,
/// then a reload that picks the session up from cookies.
///
/// Skipped unless `NIMBALYST_STYTCH_SDK_E2E=1`. It runs against production
/// Stytch with a real account's minted session, so it also needs:
/// - `NIMBALYST_STYTCH_SDK_BUNDLE`: an IIFE bundle of the console's
///   `@stytch/react/b2b` that sets `window.__createStytchB2BClient`
/// - `NIMBALYST_STYTCH_PUBLIC_TOKEN`: the production public token
/// - `NIMBALYST_STYTCH_SESSION_FILE`: the mint route's JSON response
///   (`sessionToken`, `sessionJwt`, `orgId`, `memberId`); keep it 0600
/// - `NIMBALYST_STYTCH_SDK_ORIGIN` (optional, default the production console):
///   the page origin, which must be an authorized domain in the SDK config.
///   The page is loaded with this base URL, so the SDK sends the real origin.
@MainActor
final class PagesStytchSDKTests: XCTestCase {
    private struct MintedSession: Decodable {
        let sessionToken: String
        let sessionJwt: String
        let orgId: String
        let memberId: String
    }

    private struct Observed: Decodable {
        let org: String?
        let member: String?
        let factors: [String]?
        let cookies: [String]
        let syncOrg: String?
        let error: String?
    }

    /// The console's `sessionDurationMinutes` (web-console/src/config.ts).
    private let sessionDurationMinutes = 60 * 24 * 7

    func testInstalledSDKAdoptsMintedSessionInWKWebView() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["NIMBALYST_STYTCH_SDK_E2E"] == "1" else {
            throw XCTSkip("Set NIMBALYST_STYTCH_SDK_E2E=1 and the inputs listed on PagesStytchSDKTests to run.")
        }
        let bundle = try String(contentsOfFile: try XCTUnwrap(env["NIMBALYST_STYTCH_SDK_BUNDLE"]), encoding: .utf8)
        let publicToken = try XCTUnwrap(env["NIMBALYST_STYTCH_PUBLIC_TOKEN"])
        let sessionFile = try XCTUnwrap(env["NIMBALYST_STYTCH_SESSION_FILE"])
        let minted = try JSONDecoder().decode(MintedSession.self, from: Data(contentsOf: URL(fileURLWithPath: sessionFile)))
        let origin = try XCTUnwrap(URL(string: env["NIMBALYST_STYTCH_SDK_ORIGIN"] ?? "https://console.nimbalyst.com/"))

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        // The bundle is inlined so the page's only network traffic is the SDK's own.
        let html = "<!doctype html><html><head><meta charset=\"utf-8\"><script>window.__loadNonce='LOAD_NONCE'</script></head><body><script>\(bundle)</script></body></html>"

        try await load(html, baseURL: origin, in: webView)
        let adopted = try await run("""
            const client = window.__createStytchB2BClient(publicToken);
            client.session.updateSession({ session_token: sessionToken, session_jwt: sessionJwt });
            const result = await client.session.authenticate({ session_duration_minutes: minutes });
            return {
              org: result.member_session?.organization_id ?? null,
              member: result.member?.member_id ?? null,
              factors: (result.member_session?.authentication_factors ?? []).map((f) => f.type),
            };
            """, arguments: [
                "publicToken": publicToken,
                "sessionToken": minted.sessionToken,
                "sessionJwt": minted.sessionJwt,
                "minutes": sessionDurationMinutes,
            ], in: webView)
        XCTAssertNil(adopted.error, "authenticate after updateSession failed: \(adopted.error ?? "")")
        XCTAssertEqual(adopted.org, minted.orgId)
        XCTAssertEqual(adopted.member, minted.memberId)
        XCTAssertEqual(adopted.factors, ["trusted_auth_token"])
        XCTAssertTrue(adopted.cookies.contains("stytch_session"), "cookies: \(adopted.cookies)")

        // A reload must find the session in cookies without native help.
        try await load(html, baseURL: origin, in: webView)
        let reloaded = try await run("""
            const client = window.__createStytchB2BClient(publicToken);
            const syncOrg = client.session.getSync()?.organization_id ?? null;
            const result = await client.session.authenticate({ session_duration_minutes: minutes });
            return { syncOrg, org: result.member_session?.organization_id ?? null, member: result.member?.member_id ?? null };
            """, arguments: ["publicToken": publicToken, "minutes": sessionDurationMinutes], in: webView)
        XCTAssertNil(reloaded.error, "authenticate after reload failed: \(reloaded.error ?? "")")
        XCTAssertEqual(reloaded.syncOrg, minted.orgId)
        XCTAssertEqual(reloaded.org, minted.orgId)
        XCTAssertEqual(reloaded.member, minted.memberId)

        // The minted session belongs to a real account; do not leave it alive.
        let revoked = try await run("""
            const client = window.__createStytchB2BClient(publicToken);
            await client.session.revoke();
            return {};
            """, arguments: ["publicToken": publicToken], in: webView)
        XCTAssertNil(revoked.error, "revoke failed: \(revoked.error ?? "")")
        XCTAssertFalse(revoked.cookies.contains("stytch_session"), "cookies: \(revoked.cookies)")
    }

    private func load(_ html: String, baseURL: URL, in webView: WKWebView) async throws {
        // A per-load nonce, so the wait cannot match the document being replaced.
        let nonce = UUID().uuidString
        let marker = try XCTUnwrap(html.range(of: "LOAD_NONCE"))
        webView.loadHTMLString(html.replacingCharacters(in: marker, with: nonce), baseURL: baseURL)
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            let ready = try? await webView.evaluateJavaScript(
                "window.__loadNonce === '\(nonce)' && document.readyState === 'complete' && typeof window.__createStytchB2BClient === 'function'"
            ) as? Bool
            if ready == true { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("SDK page did not load")
    }

    /// Runs `body` as an async function and reports cookies and errors without
    /// echoing any token: Stytch error messages carry no credentials.
    private func run(_ body: String, arguments: [String: Any], in webView: WKWebView) async throws -> Observed {
        let wrapped = """
            const cookies = () => document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
            try {
              const value = await (async () => { \(body) })();
              return JSON.stringify({ ...value, cookies: cookies() });
            } catch (e) {
              return JSON.stringify({ error: String(e?.error_type ?? e?.message ?? e).slice(0, 300), cookies: cookies() });
            }
            """
        let raw = try await webView.callAsyncJavaScript(wrapped, arguments: arguments, in: nil, contentWorld: .page)
        let json = try XCTUnwrap(raw as? String)
        return try JSONDecoder().decode(Observed.self, from: Data(json.utf8))
    }
}
