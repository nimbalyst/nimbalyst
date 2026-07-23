import SwiftUI
import Combine
import GRDB
import os
#if canImport(UIKit)
import UIKit
import WebKit
#endif

/// Global app state observable by all views.
/// Owns the core managers (database, crypto, sync) and exposes them to the view hierarchy.
///
/// Lifecycle:
///   1. QR pairing stores encryption seed + server URL in Keychain -> `isPaired = true`
///   2. Stytch OAuth stores JWT + user ID in Keychain -> `isAuthenticated = true`
///   3. When both paired AND authenticated, managers initialize using:
///      - Encryption seed (from QR) + Stytch user ID (from JWT) for key derivation
///      - Stytch user ID for WebSocket room routing
///   4. SyncManager connects and begins syncing
@MainActor
public final class AppState: ObservableObject {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "AppState")
    @Published public var isPaired: Bool = false
    @Published public private(set) var accounts: [MobileAccount] = []
    @Published public private(set) var activeAccountId: String?
    /// True when the account-array blob exists but cannot be decoded or recovered.
    /// The unreadable Keychain value remains preserved until the user explicitly resets it.
    @Published public private(set) var accountStorageNeedsRepair: Bool = false
    @Published public var isConnected: Bool = false
    @Published public var availableModels: [SyncedAvailableModel] = ModelPreferences.loadAvailableModels()
    @Published public var desktopDefaultModel: String? = ModelPreferences.loadDefaultModel()

    /// When true, the encryption key doesn't match the desktop's key.
    /// The user needs to re-pair their device from the desktop QR code.
    @Published public var needsRepair: Bool = false

    /// When true, sync has been failing with auth-class errors (sustained
    /// disconnect while authenticated, or repeated refreshSession failures)
    /// for long enough that the user almost certainly needs to sign in again.
    /// Drives the in-app SyncAuthDegradedBanner shown above MainNavigationView.
    @Published public var syncAuthDegraded: Bool = false

    /// When true, views should show demo connection indicators (green desktop dot).
    public var screenshotMode: Bool = false

    /// The database manager. Available after both pairing and authentication.
    /// Views use this to set up GRDB ValueObservation for reactive updates.
    @Published public private(set) var databaseManager: DatabaseManager?

    /// Auth manager for Stytch OAuth.
    public let authManager = AuthManager()

    /// Voice mode agent. One instance shared across the app (iOS only).
    #if os(iOS)
    @Published public private(set) var voiceAgent: VoiceAgent?

    /// Session the UI should navigate to because the voice agent just created it
    /// on this device. Observed by the navigation views (iPhone stack / iPad
    /// split) to open the new session. Set back to nil by the view once handled.
    @Published public var voiceNavigationRequest: String?
    #endif

    private var cryptoManager: CryptoManager?
    public private(set) var syncManager: SyncManager?
    public private(set) var documentSyncManager: DocumentSyncManager?
    private var cancellables = Set<AnyCancellable>()
    private var managerCancellables = Set<AnyCancellable>()
    private var jwtRefreshTimer: Timer?

    // MARK: - Sync auth-degraded tracking

    /// Number of consecutive `.failed` results from `authManager.refreshSession`.
    /// Reset to 0 on `.success`. At `refreshFailureBannerThreshold` we surface
    /// the degraded banner; at `refreshFailureEscalationThreshold` we treat the
    /// situation as `.sessionExpired` and force a logout. Without escalation,
    /// historically the timer would retry forever -- today's Stytch JWKS
    /// rotation incident (2026-05-20) silently broke every iOS client because
    /// refreshSession returned 403 (not 401/404) and 403 mapped to `.failed`.
    private var consecutiveRefreshFailures: Int = 0
    private static let refreshFailureBannerThreshold = 3
    private static let refreshFailureEscalationThreshold = 5

    /// Timestamp of the last `isConnected: true -> false` transition while
    /// the user was authenticated. Cleared on reconnect, logout, or unpair.
    /// Used to detect sustained auth-class disconnects.
    private var disconnectedSinceWhileAuthed: Date?

    /// One-shot timer that re-evaluates `syncAuthDegraded` after the sustained
    /// disconnect window has elapsed. Rescheduled on each disconnect; cancelled
    /// on reconnect, logout, or unpair.
    private var degradedBannerCheckTimer: Timer?

    /// How long sync must stay disconnected (while authenticated) before the
    /// degraded banner appears. Long enough to ride out normal startup churn
    /// and short network blips, short enough that a real broken-session day
    /// (like the JWKS rotation incident) surfaces visibly within a minute.
    private static let sustainedDisconnectThreshold: TimeInterval = 60

    public init() {
        // Initialize analytics early so events can be captured throughout the lifecycle
        AnalyticsManager.shared.initialize()

        // Loading account state also performs the one-time legacy Keychain migration.
        refreshAccountsFromKeychain()

        // If both paired and authenticated from a previous session, set up and connect immediately
        if isPaired && authManager.isAuthenticated {
            setupManagers()
            connectIfReady()

            // Pre-warm a WKWebView so transcript loading is instant when the user
            // opens a session. Only worth doing when paired+authenticated (user can
            // navigate to sessions). Warming up at launch when unpaired causes the
            // WebContent process to hang and block gesture recognition on iPad.
            warmupTranscriptWebViewIfAppropriate()
        }

        // Auto-connect when auth state changes
        observeAuth()
        observeAppLifecycle()
    }

    private func observeAppLifecycle() {
        #if canImport(UIKit)
        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.syncManager?.setAppInForeground(false)
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.syncManager?.setAppInForeground(true)
            }
            .store(in: &cancellables)
        #endif
    }

    /// Initialize with pre-built managers (for testing and previews).
    public init(databaseManager: DatabaseManager) {
        self.databaseManager = databaseManager
        self.isPaired = true
        observeAuth()
    }

    /// Store pairing credentials from QR code.
    /// The QR code provides the encryption seed and server URL.
    /// The userId parameter is informational only (e.g., syncEmail from QR) -- the actual
    /// user ID for crypto and routing comes from Stytch auth.
    public func pair(with seed: String, serverUrl: String, userId: String, analyticsId: String? = nil, personalOrgId: String? = nil, personalUserId: String? = nil) throws {
        let wasAuthenticated = authManager.isAuthenticated
        let account = try KeychainManager.upsertPairingAccount(
            email: userId,
            personalOrgId: personalOrgId ?? "",
            stytchUserId: personalUserId,
            e2eSeed: seed,
            serverUrl: serverUrl,
            analyticsId: analyticsId
        )

        // Pairing selects the scanned account. Tear down every room belonging
        // to the prior selection before rebuilding the selected account scope.
        tearDownManagers()
        DatabaseManager.deleteDatabase(at: DatabaseManager.path(for: account))
        refreshAccountsFromKeychain()
        authManager.reloadSelectedAccount()
        logger.info("Paired with userId=\(userId), personalOrgId=\(personalOrgId ?? "nil"), personalUserId=\(personalUserId ?? "nil")")
        isPaired = true

        // Link mobile analytics to desktop's PostHog identity
        AnalyticsManager.shared.setDistinctIdFromPairing(analyticsId)
        AnalyticsManager.shared.capture("mobile_pairing_completed")
        // If already authenticated (re-pairing scenario), set up managers and connect.
        // On fresh install this won't fire -- the auth observer handles post-login setup.
        if authManager.isAuthenticated && wasAuthenticated {
            setupManagers()
            connectIfReady()
            warmupTranscriptWebViewIfAppropriate()
        }
    }

    public func unpair() {
        logger.error("unpair() called! Stack: \(Thread.callStackSymbols.joined(separator: "\n"))")
        AnalyticsManager.shared.capture("mobile_device_unpairing")
        AnalyticsManager.shared.reset()

        // Erase all rows while the database connection is still open.
        // Deleting the file after nilling refs is unreliable because ARC may
        // not immediately dealloc the DatabasePool, leaving the file locked.
        try? databaseManager?.eraseAllData()
        tearDownManagers()
        KeychainManager.deleteAll()
        authManager.logout()
        // Also attempt file deletion for a clean slate on re-pair.
        DatabaseManager.deleteDatabase()
        isPaired = false
        accounts = []
        activeAccountId = nil
        accountStorageNeedsRepair = false
        isConnected = false
        clearSyncAuthDegradedState()
    }

    /// Select one paired account as the sole mobile runtime scope.
    public func switchAccount(to accountId: String) throws {
        guard accountId != activeAccountId else { return }
        guard accounts.contains(where: { $0.id == accountId }) else {
            throw MobileAccountError.accountNotFound(accountId)
        }

        tearDownManagers()
        _ = try KeychainManager.setActiveAccount(id: accountId)
        refreshAccountsFromKeychain()
        let wasAuthenticated = authManager.isAuthenticated
        authManager.reloadSelectedAccount()

        if authManager.isAuthenticated && wasAuthenticated {
            setupManagers()
            connectIfReady()
            warmupTranscriptWebViewIfAppropriate()
        }
    }

    private func refreshAccountsFromKeychain() {
        let result = KeychainManager.getAccountLoadResult()
        accounts = result.state.accounts
        activeAccountId = result.state.activeAccountId
        accountStorageNeedsRepair = result.requiresExplicitRepair
        // A corrupt present blob is not equivalent to an unpaired phone. Keep it
        // out of the pairing flow until the user explicitly chooses to reset.
        isPaired = !result.state.accounts.isEmpty || result.requiresExplicitRepair
    }

    /// Disconnect sync and log out of Stytch, routing the user to LoginView.
    /// Pairing and synced data are preserved on this device. Used by the
    /// SyncAuthDegradedBanner when the user taps "Sign in again", and matches
    /// what the Settings "Sign Out" button does inline.
    public func signOutForAuthRecovery() {
        logger.info("signOutForAuthRecovery invoked")
        syncManager?.disconnect()
        authManager.logout()
        // clearSyncAuthDegradedState() runs via the $isAuthenticated observer
        // when logout flips isAuthenticated to false.
    }

    /// Request a full index sync from the server.
    public func requestSync() {
        syncManager?.requestFullSync()
    }

    // MARK: - Auth Observation

    private func observeAuth() {
        // Forward authManager changes to AppState so SwiftUI re-renders ContentView.
        // SwiftUI doesn't observe nested ObservableObject properties automatically.
        authManager.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)

        authManager.$isAuthenticated
            .dropFirst()
            // @Published fires in willSet (before the property updates).
            // Dispatch to next run loop tick so authManager.isAuthenticated
            // reflects the new value when connectIfReady() reads it.
            .receive(on: DispatchQueue.main)
            .sink { [weak self] authenticated in
                guard let self else { return }
                self.logger.info("isAuthenticated changed to \(authenticated)")
                if authenticated {
                    AnalyticsManager.shared.capture("mobile_login_completed")
                    self.setupManagersIfNeeded()
                    self.connectIfReady()
                    self.warmupTranscriptWebViewIfAppropriate()
                } else {
                    // Auth lost for the selected account: no rooms or database
                    // observations from that account may remain live.
                    self.tearDownManagers()
                }
            }
            .store(in: &cancellables)
    }

    private func warmupTranscriptWebViewIfAppropriate() {
        #if canImport(UIKit)
        #if os(iOS)
        if UIDevice.current.userInterfaceIdiom == .pad {
            logger.info("Skipping transcript web view warmup on iPad")
            return
        }
        #endif

        if !TranscriptWebViewPool.shared.hasWarmWebView {
            TranscriptWebViewPool.shared.warmup()
        }
        #endif
    }

    /// Set up managers after authentication. Rebuild existing managers because
    /// SyncManager and DocumentSyncManager retain the CryptoManager supplied at init.
    private func setupManagersIfNeeded() {
        if databaseManager != nil {
            tearDownManagers()
        }
        setupManagers()
    }

    /// Connect to the sync server if both paired and authenticated.
    /// If the JWT is near expiration, refreshes it first before connecting.
    private func connectIfReady() {
        guard isPaired else {
            logger.debug("connectIfReady: not paired")
            return
        }
        guard authManager.isAuthenticated else {
            logger.debug("connectIfReady: not authenticated")
            return
        }
        guard let jwt = authManager.sessionJwt else {
            logger.warning("connectIfReady: no JWT")
            return
        }
        guard let authUserId = authManager.authUserId else {
            logger.warning("connectIfReady: no authUserId")
            return
        }
        guard let sync = syncManager else {
            logger.warning("connectIfReady: no syncManager")
            return
        }

        // Check if the JWT is expired or about to expire (within 60s).
        // Stytch JWTs have a 5-minute lifetime, and the auth callback JWT
        // may already be stale by the time pairing + auth completes.
        if isJWTExpiringSoon(jwt) {
            logger.info("connectIfReady: JWT expiring soon, refreshing first")
            Task {
                await refreshJWT()
            }
            return
        }

        // Get orgId for room routing. Prefer pairing's personalOrgId (from desktop QR v5+)
        // over the auth callback's orgId, because the desktop uses personalOrgId for its
        // sync room IDs and they must match for cross-device sync to work.
        let orgId: String
        let effectiveAuthUserId: String
        if let pairingOrgId = KeychainManager.getPairingPersonalOrgId(),
           let pairingUserId = KeychainManager.getPairingPersonalUserId() {
            orgId = pairingOrgId
            effectiveAuthUserId = pairingUserId
            logger.info("connectIfReady: using pairing personalOrgId=\(pairingOrgId), personalUserId=\(pairingUserId)")
        } else if let stored = authManager.orgId {
            orgId = stored
            effectiveAuthUserId = authUserId
        } else if let extracted = extractOrgIdFromJWT(jwt) {
            orgId = extracted
            effectiveAuthUserId = authUserId
            // Backfill keychain so we don't need to extract again
            try? KeychainManager.storeAuthSession(
                sessionToken: KeychainManager.getSessionToken() ?? "",
                sessionJwt: jwt,
                userId: authUserId,
                email: authManager.email ?? "",
                expiresAt: "",
                orgId: extracted
            )
            logger.info("Backfilled orgId from JWT: \(extracted)")
        } else {
            logger.warning("connectIfReady: no orgId in keychain or JWT, re-login required")
            return
        }

        logger.info("Connecting to sync server")
        sync.connect(authToken: jwt, authUserId: effectiveAuthUserId, orgId: orgId)

        // Pass auth credentials to DocumentSyncManager for project room connections
        documentSyncManager?.setAuth(authToken: jwt, authUserId: effectiveAuthUserId, orgId: orgId)

        startJWTRefreshTimer()
    }

    /// Check if a JWT's exp claim is within `margin` seconds of now.
    private func isJWTExpiringSoon(_ jwt: String, margin: TimeInterval = 60) -> Bool {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return true }

        // Decode the payload (base64url -> base64 -> Data -> JSON)
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let pad = base64.count % 4
        if pad > 0 { base64 += String(repeating: "=", count: 4 - pad) }

        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let exp = json["exp"] as? Double else {
            return true // Can't parse, treat as expired
        }

        return Date(timeIntervalSince1970: exp).timeIntervalSinceNow < margin
    }

    /// Extract the organization_id from a B2B JWT's `https://stytch.com/organization` claim.
    private func extractOrgIdFromJWT(_ jwt: String) -> String? {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return nil }

        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let pad = base64.count % 4
        if pad > 0 { base64 += String(repeating: "=", count: 4 - pad) }

        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let orgClaim = json["https://stytch.com/organization"] as? [String: Any],
              let orgId = orgClaim["organization_id"] as? String else {
            return nil
        }
        return orgId
    }

    // MARK: - JWT Refresh

    /// Stytch JWTs expire after ~5 minutes. Refresh every 4 minutes to stay connected.
    private func startJWTRefreshTimer() {
        jwtRefreshTimer?.invalidate()
        jwtRefreshTimer = Timer.scheduledTimer(withTimeInterval: 4 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refreshJWT()
            }
        }
    }

    private func refreshJWT() async {
        guard let serverUrl = KeychainManager.getServerUrl() else { return }
        let result = await authManager.refreshSession(serverUrl: serverUrl)
        switch result {
        case .success:
            consecutiveRefreshFailures = 0
            // Reconnect with fresh JWT
            connectIfReady()
        case .accountChanged:
            // A switch already rebuilt (or will rebuild) the selected account.
            // The old in-flight refresh must not affect its failure counters.
            return
        case .sessionExpired:
            // Session is dead -- log the user out so they see the login screen
            // with an explanation of what happened.
            logger.warning("Session expired, logging out to prompt re-authentication")
            handleSessionExpired(reason: "Your session has expired. Please sign in again.")
        case .failed:
            // Transient failure (network, server error) or non-401/404 server
            // status that AuthManager couldn't classify as "dead session".
            // Track consecutive failures so a sustained outage (like Stytch's
            // 2026-05-20 JWKS rotation, which returned 403) escalates to a
            // logout + login prompt instead of retrying forever in silence.
            consecutiveRefreshFailures += 1
            let count = consecutiveRefreshFailures
            logger.warning("JWT refresh failed (transient, \(count) consecutive)")

            if count >= AppState.refreshFailureEscalationThreshold {
                logger.error("JWT refresh has failed \(count) consecutive times; escalating to sessionExpired")
                handleSessionExpired(reason: "Your session could not be refreshed. Please sign in again.")
                return
            }
            if count >= AppState.refreshFailureBannerThreshold && !syncAuthDegraded {
                logger.warning("Surfacing degraded banner after \(count) consecutive refresh failures")
                syncAuthDegraded = true
            }
        }
    }

    /// Tear down the JWT refresh timer, disconnect sync, log the user out,
    /// and surface a reason on the login screen. Shared between the
    /// AuthManager-reported `.sessionExpired` path and the consecutive-failure
    /// escalation path.
    private func handleSessionExpired(reason: String) {
        jwtRefreshTimer?.invalidate()
        jwtRefreshTimer = nil
        syncManager?.disconnect()
        authManager.logout()
        authManager.authError = reason
        // clearSyncAuthDegradedState() runs via the $isAuthenticated observer
        // when logout flips isAuthenticated to false.
    }

    // MARK: - Sync degraded-banner tracking

    /// Reset all sync auth-degraded tracking (counter, timestamp, timer,
    /// banner flag). Called when sync reconnects, when the user logs out
    /// or is escalated to sessionExpired, and on unpair.
    private func clearSyncAuthDegradedState() {
        consecutiveRefreshFailures = 0
        disconnectedSinceWhileAuthed = nil
        degradedBannerCheckTimer?.invalidate()
        degradedBannerCheckTimer = nil
        if syncAuthDegraded {
            syncAuthDegraded = false
        }
    }

    /// Called whenever the sync manager's connection state changes.
    /// On reconnect we clear all degraded-state tracking. On disconnect
    /// (while authenticated) we record the timestamp and schedule a one-shot
    /// re-evaluation at `sustainedDisconnectThreshold` seconds out.
    private func handleSyncConnectionChange(connected: Bool) {
        if connected {
            clearSyncAuthDegradedState()
            return
        }
        guard authManager.isAuthenticated else { return }
        if disconnectedSinceWhileAuthed == nil {
            disconnectedSinceWhileAuthed = Date()
        }
        scheduleDegradedBannerCheck()
    }

    private func scheduleDegradedBannerCheck() {
        degradedBannerCheckTimer?.invalidate()
        degradedBannerCheckTimer = Timer.scheduledTimer(
            withTimeInterval: AppState.sustainedDisconnectThreshold,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.evaluateDegradedBanner()
            }
        }
    }

    /// Fires `sustainedDisconnectThreshold` after a disconnect-while-authed.
    /// If we're still disconnected and still authenticated, surface the
    /// banner. The user can then either tap "Sign in again" or wait for the
    /// refresh-failure escalation path (~20 min) to log them out automatically.
    private func evaluateDegradedBanner() {
        guard authManager.isAuthenticated else { return }
        guard !isConnected else { return }
        guard let since = disconnectedSinceWhileAuthed,
              Date().timeIntervalSince(since) >= AppState.sustainedDisconnectThreshold else {
            return
        }
        guard !syncAuthDegraded else { return }
        let elapsed = Int(Date().timeIntervalSince(since))
        logger.warning("Sync degraded: disconnected for \(elapsed)s while authenticated; surfacing banner")
        syncAuthDegraded = true
    }

    private func setupManagers() {
        guard let account = KeychainManager.getActiveAccount() else {
            logger.warning("setupManagers: no selected account in Keychain")
            return
        }
        let seed = account.e2eSeed

        // Key derivation must use the same userId as the desktop.
        // The desktop derives: PBKDF2(seed, "nimbalyst:<personalUserId>")
        // where personalUserId is the Stytch member ID from the personal org.
        // Prefer the pairing personalUserId (from QR v5+) because that's exactly
        // what the desktop uses. Fall back to authUserId for older QR versions.
        let keyUserId: String
        if let pairingUserId = account.stytchUserId {
            keyUserId = pairingUserId
        } else if let authUserId = account.authUserId {
            keyUserId = authUserId
        } else {
            logger.debug("setupManagers: no userId available for key derivation, deferring until auth completes")
            return
        }
        logger.info("Initializing managers (keyUserId=\(keyUserId))")

        // Set email on analytics profile if available from Stytch auth
        if let email = KeychainManager.getAuthEmail() {
            AnalyticsManager.shared.setEmail(email)
        }

        // Initialize CryptoManager with the correct userId for key derivation
        cryptoManager = CryptoManager(seed: seed, userId: keyUserId)

        // Initialize DatabaseManager
        do {
            databaseManager = try DatabaseManager(path: DatabaseManager.path(for: account))
        } catch {
            logger.error("Failed to initialize DatabaseManager: \(error.localizedDescription)")
            return
        }

        // Initialize SyncManager
        guard let crypto = cryptoManager,
              let database = databaseManager,
              let serverUrl = KeychainManager.getServerUrl() else { return }

        let sync = SyncManager(crypto: crypto, database: database, serverUrl: serverUrl, userId: keyUserId)
        syncManager = sync

        // Initialize DocumentSyncManager for project file sync
        let docSync = DocumentSyncManager(crypto: crypto, database: database, serverUrl: serverUrl, userId: keyUserId)
        documentSyncManager = docSync

        // Observe sync connection state
        sync.$isConnected
            .receive(on: DispatchQueue.main)
            .sink { [weak self] connected in
                self?.isConnected = connected
            }
            .store(in: &managerCancellables)

        // Drive degraded-banner tracking from the same publisher. We use a
        // separate subscription because `assign(to:&)` is a terminal Combine
        // operator -- it doesn't fan out -- and we need to schedule a one-shot
        // timer on each disconnect rather than just mirror the value.
        sync.$isConnected
            .receive(on: DispatchQueue.main)
            .removeDuplicates()
            .sink { [weak self] connected in
                self?.handleSyncConnectionChange(connected: connected)
            }
            .store(in: &managerCancellables)

        // Observe encryption key mismatch (wrong pairing / stale key)
        sync.$encryptionKeyMismatch
            .receive(on: DispatchQueue.main)
            .sink { [weak self] mismatch in
                self?.needsRepair = mismatch
            }
            .store(in: &managerCancellables)

        #if os(iOS)
        // Initialize voice agent
        let voice = VoiceAgent()
        voiceAgent = voice

        // Wire session completion notifications from SyncManager to VoiceAgent
        sync.onSessionCompleted = { [weak voice] sessionId, summary in
            Task { @MainActor in
                voice?.onSessionCompleted(sessionId: sessionId, summary: summary)
            }
        }

        // When the voice agent creates a session, switch this device's UI to it.
        // Only the device that issued the request navigates (matched by requestId);
        // other paired devices just see the session appear in their list.
        sync.onSessionCreated = { [weak self, weak voice] requestId, sessionId in
            Task { @MainActor in
                guard let self, let voice,
                      voice.consumePendingCreateSession(requestId: requestId) else { return }
                voice.activeSessionId = sessionId
                await self.navigateWhenSessionAvailable(sessionId)
            }
        }

        // Wire settings sync to update VoiceAgent and model list when settings arrive from desktop
        sync.onSettingsSynced = { [weak self, weak voice] settings in
            Task { @MainActor in
                voice?.settings = VoiceModeSettings.load()
                if let models = settings.availableModels {
                    self?.availableModels = models
                }
                if let defaultModel = settings.defaultModel {
                    self?.desktopDefaultModel = defaultModel
                }
            }
        }

        // Forward VoiceAgent state changes to trigger SwiftUI re-renders
        voice.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &managerCancellables)
        #endif
    }

    /// Stop every account-scoped resource before selecting or authenticating
    /// another account. Removing the manager subscriptions is important: an old
    /// SyncManager publishing after a switch must not mutate the new UI scope.
    private func tearDownManagers() {
        jwtRefreshTimer?.invalidate()
        jwtRefreshTimer = nil
        degradedBannerCheckTimer?.invalidate()
        degradedBannerCheckTimer = nil

        #if os(iOS)
        voiceAgent?.deactivate()
        voiceAgent = nil
        #endif

        documentSyncManager?.disconnectAll()
        syncManager?.disconnect()
        managerCancellables.removeAll()
        documentSyncManager = nil
        syncManager = nil
        cryptoManager = nil
        databaseManager = nil
        isConnected = false
        needsRepair = false
        clearSyncAuthDegradedState()
    }

    /// Configure the voice agent with a specific project context.
    /// Called when the user navigates to a project's session list.
    public func configureVoiceAgent(forProject projectId: String) {
        #if os(iOS)
        guard let voice = voiceAgent,
              let database = databaseManager,
              let sync = syncManager else { return }
        voice.configure(database: database, syncManager: sync, projectId: projectId)
        #endif
    }

    #if os(iOS)
    /// Publish a navigation request to the just-created session once its row has
    /// synced into the local database. The `createSessionResponseBroadcast` can
    /// arrive before the session's `indexBroadcast`, so we briefly wait for the
    /// row rather than navigate to a session the views can't yet resolve.
    @MainActor
    private func navigateWhenSessionAvailable(_ sessionId: String) async {
        for _ in 0..<25 { // ~5s max (25 * 200ms)
            if let db = databaseManager, (try? db.session(byId: sessionId)) != nil {
                voiceNavigationRequest = sessionId
                return
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        // Fall back: navigate anyway; the view retries the row lookup itself.
        voiceNavigationRequest = sessionId
    }
    #endif

    // MARK: - Screenshot Mode

    #if DEBUG
    /// Create an AppState configured for screenshot capture.
    /// Uses an in-memory database with realistic demo data, bypasses auth/pairing.
    public static func forScreenshots() -> AppState {
        let db = try! ScreenshotDataProvider.createPopulatedDatabase()
        let state = AppState(databaseManager: db)
        state.authManager.isAuthenticated = true
        state.isConnected = true
        state.screenshotMode = true
        return state
    }
    #endif
}
