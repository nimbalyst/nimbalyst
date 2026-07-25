import Foundation
import AuthenticationServices
import os

/// Handles Stytch OAuth authentication via ASWebAuthenticationSession.
///
/// Flow:
/// 1. Opens Safari sheet to `<serverUrl>/auth/login/google`
/// 2. User authenticates with Google via Stytch
/// 3. Server redirects to `nimbalyst://auth/callback?session_token=...&session_jwt=...`
/// 4. We capture the callback URL and store credentials in Keychain
/// 5. SyncManager uses the JWT to connect to the WebSocket server
@MainActor
public final class AuthManager: ObservableObject {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "AuthManager")

    @Published public var isAuthenticated: Bool = false
    @Published public var email: String?
    @Published public var isAuthenticating: Bool = false
    @Published public var authError: String?
    @Published public var magicLinkSent: Bool = false

    /// Retained to prevent deallocation during the browser flow.
    private var authSession: ASWebAuthenticationSession?
    private var authenticationAccountId: String?

    /// The JWT for sync server authentication.
    public var sessionJwt: String? {
        KeychainManager.getSessionJwt()
    }

    /// The Stytch user ID (from JWT sub claim).
    public var authUserId: String? {
        KeychainManager.getAuthUserId()
    }

    /// The Stytch organization ID (from B2B discovery flow).
    public var orgId: String? {
        KeychainManager.getAuthOrgId()
    }

    public init() {
        reloadSelectedAccount()
    }

    /// Refresh published auth state after the user selects or pairs an account.
    /// Session getters remain computed from Keychain, so this only updates the
    /// SwiftUI-facing state for the newly selected account.
    public func reloadSelectedAccount() {
        let selectedIsAuthenticated = KeychainManager.hasAuthSession()
        if isAuthenticated != selectedIsAuthenticated {
            isAuthenticated = selectedIsAuthenticated
        }
        email = KeychainManager.getAuthEmail()
        authError = nil
        magicLinkSent = false
    }

    // MARK: - Login

    #if os(iOS)
    /// Start the Google OAuth login flow.
    /// Opens a Safari sheet that redirects back to the app via `nimbalyst://` deep link.
    public func login(serverUrl: String) {
        guard !isAuthenticating else { return }
        authenticationAccountId = KeychainManager.getActiveAccount()?.id
        authError = nil

        // Convert WebSocket URLs to HTTPS (ASWebAuthenticationSession requires HTTP/HTTPS)
        let baseUrl = serverUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        // The server's OAuth endpoint
        guard let loginUrl = URL(string: "\(baseUrl)/auth/login/google") else {
            authError = "Invalid server URL"
            return
        }

        isAuthenticating = true
        authError = nil

        // ASWebAuthenticationSession handles the full browser flow and captures
        // the callback URL with our custom scheme.
        // Must be stored as a property to prevent deallocation during the browser flow.
        authSession = ASWebAuthenticationSession(
            url: loginUrl,
            callbackURLScheme: "nimbalyst"
        ) { [weak self] callbackURL, error in
            Task { @MainActor in
                self?.isAuthenticating = false
                self?.authSession = nil

                if let error {
                    if (error as NSError).code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        self?.logger.info("Login cancelled by user")
                        return
                    }
                    self?.logger.error("Auth error: \(error.localizedDescription)")
                    self?.authError = error.localizedDescription
                    return
                }

                guard let callbackURL else {
                    self?.authError = "No callback URL received"
                    return
                }

                self?.handleCallback(callbackURL)
            }
        }

        // Present the auth session
        authSession?.presentationContextProvider = ASWebAuthPresentationContext.shared
        authSession?.start()
    }
    #endif

    // MARK: - Magic Link

    #if os(iOS)
    /// Send a magic link email to the given address for passwordless login.
    /// The server sends the email via Stytch; the magic link redirects through
    /// the server's `/auth/callback` which then issues a `nimbalyst://auth/callback` deep link.
    public func sendMagicLink(email: String, serverUrl: String) {
        guard !isAuthenticating else { return }
        authenticationAccountId = KeychainManager.getActiveAccount()?.id
        authError = nil

        let baseUrl = serverUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        guard let url = URL(string: "\(baseUrl)/api/auth/magic-link") else {
            authError = "Invalid server URL"
            return
        }

        isAuthenticating = true
        authError = nil
        magicLinkSent = false

        // The magic link callback goes to the server's /auth/callback, which
        // authenticates the token and redirects to nimbalyst://auth/callback.
        let callbackUrl = "\(baseUrl)/auth/callback"

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "email": email,
            "redirect_url": callbackUrl,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                await MainActor.run {
                    isAuthenticating = false

                    guard let httpResponse = response as? HTTPURLResponse else {
                        authError = "Unexpected response"
                        return
                    }

                    if httpResponse.statusCode == 200 {
                        magicLinkSent = true
                        logger.info("Magic link sent to \(email)")
                    } else {
                        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                        let errorMsg = json?["error"] as? String ?? "Failed to send magic link"
                        authError = errorMsg
                        logger.error("Magic link failed: \(errorMsg)")
                    }
                }
            } catch {
                await MainActor.run {
                    isAuthenticating = false
                    authError = "Network error: \(error.localizedDescription)"
                    logger.error("Magic link request failed: \(error.localizedDescription)")
                }
            }
        }
    }
    #endif

    // MARK: - Callback

    /// Handle the `nimbalyst://auth/callback?...` deep link.
    ///
    /// Validates that the authenticated email matches the pairing email from the QR code.
    /// The desktop derives encryption keys using `PBKDF2(seed, "nimbalyst:<stytchUserId>")`,
    /// so the mobile app MUST authenticate as the same user to derive the same key.
    public func handleCallback(_ url: URL) {
        NSLog("[AuthManager] handleCallback called with URL: \(url.absoluteString.prefix(120))")
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems else {
            NSLog("[AuthManager] handleCallback: Invalid callback URL - no components/queryItems")
            authError = "Invalid callback URL"
            return
        }

        let params = Dictionary(uniqueKeysWithValues: queryItems.compactMap { item -> (String, String)? in
            guard let value = item.value else { return nil }
            return (item.name, value)
        })
        NSLog("[AuthManager] handleCallback params: \(params.keys.sorted().joined(separator: ", "))")

        guard let sessionToken = params["session_token"],
              let sessionJwt = params["session_jwt"],
              let userId = params["user_id"],
              let orgId = params["org_id"] else {
            authError = "Missing required auth parameters"
            NSLog("[AuthManager] handleCallback MISSING params. Got: \(params.keys.joined(separator: ", "))")
            return
        }

        let email = params["email"] ?? ""
        let expiresAt = params["expires_at"] ?? ""

        if let authenticationAccountId,
           authenticationAccountId != KeychainManager.getActiveAccount()?.id {
            authError = "The selected account changed while sign-in was open. Please try again."
            return
        }

        // Validate against only the account currently being paired/selected.
        // Other paired accounts may intentionally use different email addresses.
        do {
            try KeychainManager.validateAuthenticatedEmail(email)
        } catch {
            authError = error.localizedDescription
            NSLog("[AuthManager] EMAIL MISMATCH for selected account: logged in as \(email)")
            return
        }

        do {
            try KeychainManager.storeAuthSession(
                sessionToken: sessionToken,
                sessionJwt: sessionJwt,
                userId: userId,
                email: email,
                expiresAt: expiresAt,
                orgId: orgId
            )
            isAuthenticated = true
            self.email = email
            authError = nil
            authenticationAccountId = nil
            NSLog("[AuthManager] Authentication SUCCESS for \(email) orgId=\(orgId)")
        } catch {
            authError = "Failed to store auth session: \(error.localizedDescription)"
            NSLog("[AuthManager] Authentication FAILED: \(error.localizedDescription)")
        }
    }

    // MARK: - Refresh

    public enum RefreshResult: Equatable {
        case success
        /// The selected account changed while the refresh request was in flight.
        case accountChanged
        /// Session token is expired or revoked -- user must re-authenticate.
        case sessionExpired
        /// Transient failure (network error, server error) -- worth retrying.
        case failed
    }

    nonisolated static func refreshResultWhenSelectionChanges(
        startedAccountId: String,
        currentAccountId: String?
    ) -> RefreshResult? {
        currentAccountId == startedAccountId ? nil : .accountChanged
    }

    /// Refresh the session JWT using the session token.
    public func refreshSession(serverUrl: String) async -> RefreshResult {
        guard let refreshAccountId = KeychainManager.getActiveAccount()?.id,
              let sessionToken = KeychainManager.getSessionToken() else {
            logger.warning("No session token to refresh")
            return .sessionExpired
        }

        let baseUrl = serverUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(baseUrl)/auth/refresh") else {
            return .failed
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = ["session_token": sessionToken]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let selectionResult = Self.refreshResultWhenSelectionChanges(
                startedAccountId: refreshAccountId,
                currentAccountId: KeychainManager.getActiveAccount()?.id
            ) {
                logger.info("Ignoring JWT refresh after account selection changed")
                return selectionResult
            }
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

            guard statusCode == 200 else {
                logger.warning("Refresh failed with status: \(statusCode)")

                // Stytch returns 404 for revoked/unknown sessions and 401 for expired.
                // The server also sets "expired: true" in the JSON body for 401.
                // Both mean the session is dead and the user must re-authenticate.
                if statusCode == 401 || statusCode == 404 {
                    return .sessionExpired
                }
                return .failed
            }

            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sessionJwt = json["session_jwt"] as? String else {
                logger.error("Invalid refresh response")
                return .failed
            }

            // Update just the JWT in keychain
            let sessionToken = json["session_token"] as? String ?? KeychainManager.getSessionToken() ?? ""
            let userId = json["user_id"] as? String ?? KeychainManager.getAuthUserId() ?? ""
            let email = json["email"] as? String ?? KeychainManager.getAuthEmail() ?? ""
            let expiresAt = json["expires_at"] as? String ?? ""
            let orgId = json["org_id"] as? String ?? KeychainManager.getAuthOrgId() ?? ""

            try KeychainManager.storeAuthSession(
                sessionToken: sessionToken,
                sessionJwt: sessionJwt,
                userId: userId,
                email: email,
                expiresAt: expiresAt,
                orgId: orgId
            )

            logger.info("JWT refreshed successfully")
            return .success
        } catch {
            if let selectionResult = Self.refreshResultWhenSelectionChanges(
                startedAccountId: refreshAccountId,
                currentAccountId: KeychainManager.getActiveAccount()?.id
            ) {
                return selectionResult
            }
            logger.error("Refresh request failed: \(error.localizedDescription)")
            return .failed
        }
    }

    // MARK: - Account Deletion

    /// Delete the user's account and all server-side data.
    /// Calls the server's /api/account/delete endpoint, then clears local state.
    public func deleteAccount(serverUrl: String) async -> (success: Bool, error: String?) {
        guard let jwt = KeychainManager.getSessionJwt() else {
            return (false, "Not authenticated")
        }

        let baseUrl = serverUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(baseUrl)/api/account/delete") else {
            return (false, "Invalid server URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return (false, "Unexpected response")
            }

            if httpResponse.statusCode == 200 {
                logger.info("Account deleted successfully")
                // Clear local state
                logout()
                return (true, nil)
            } else {
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                let errorMsg = json?["error"] as? String ?? "Account deletion failed (HTTP \(httpResponse.statusCode))"
                logger.error("Account deletion failed: \(errorMsg)")
                return (false, errorMsg)
            }
        } catch {
            logger.error("Account deletion request failed: \(error.localizedDescription)")
            return (false, "Network error: \(error.localizedDescription)")
        }
    }

    // MARK: - Logout

    public func logout() {
        KeychainManager.deleteAuthSession()
        isAuthenticated = false
        email = nil
        authError = nil
        magicLinkSent = false
    }
}

// MARK: - ASWebAuthenticationSession Presentation

#if os(iOS)
/// Provides the presentation anchor for ASWebAuthenticationSession.
final class ASWebAuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = ASWebAuthPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // Find the key window scene's key window
        let scenes = UIApplication.shared.connectedScenes
        let windowScene = scenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
        return windowScene?.windows.first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}
#endif
