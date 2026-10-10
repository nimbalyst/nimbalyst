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
    /// Set when a `nimbalyst://pair` deep link is opened externally (e.g. the
    /// Camera app scanned the pairing QR). `PairingView` observes this and opens
    /// the in-app scanner so the user can re-scan through the app's own camera.
    /// No payload from the deep link is applied — only the scanner is surfaced.
    @Published public var pairingScannerRequested: Bool = false
    @Published public private(set) var accounts: [MobileAccount] = []
    @Published public private(set) var activeAccountId: String?
    /// True when the account-array blob exists but cannot be decoded or recovered.
    /// The unreadable Keychain value remains preserved until the user explicitly resets it.
    @Published public private(set) var accountStorageNeedsRepair: Bool = false
    @Published public var isConnected: Bool = false
    @Published public var indexLoadState: IndexLoadState = .loading
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

    /// Session to open after creation on this device, through voice or the UI.
    /// Cleared by the navigation view once handled.
    @Published public var voiceNavigationRequest: String?
    #endif

    private var cryptoManager: CryptoManager?
    public private(set) var syncManager: SyncManager?
    public private(set) var documentSyncManager: DocumentSyncManager?
    private var cancellables = Set<AnyCancellable>()
    private var managerCancellables = Set<AnyCancellable>()
    private var jwtRefreshTimer: Timer?
    private var networkObserver: SyncNetworkObserver?
    private var lastCountedRefreshFailure: Date?
    private lazy var recovery = SyncRecoveryCoordinator { [weak self] in
        await self?.performSyncRecovery() ?? false
    }

    /// Mints console sessions for Pages and owns the per-account web data store.
    /// Owned here, not by `PagesView`, so a view remount never drops a request.
    public private(set) var consoleBroker: ConsoleSessionBroker?
    var consoleEnvironment: ConsoleEnvironment = .production
    /// Bumped on every pairing, account switch, sign-in and sign-out. Pages work
    /// and session answers captured under one generation never act under another.
    var consoleGeneration: UInt64 = 0
    #if canImport(UIKit)
    /// The one long-lived Pages web view, bound to one account generation (see AppState+Pages).
    var pagesWebController: PagesWebController?
    var consoleReachability: ConsoleReachability?
    /// The store from a previous sign-out could not be removed yet, so Pages cannot open.
    var pagesStoreBlocked = false
    #endif
    #if DEBUG
    /// `--console-pages-fixture`: every project maps to this team (screenshots and UI tests).
    public var consolePagesFixtureMatch: ConsoleTeamProjectMatch?
    #endif

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

    /// How long sync must stay disconnected (while authenticated and in the
    /// foreground) before the degraded banner appears. Long enough to ride out
    /// normal startup churn and short network blips, short enough that a real
    /// broken-session day (like the JWKS rotation incident) surfaces visibly
    /// within a minute. Cleared on reconnect, logout, or unpair.
    private var disconnectClock = SustainedDisconnectClock(threshold: 60)

    /// One-shot timer that re-evaluates `syncAuthDegraded` after the sustained
    /// disconnect window has elapsed. Rescheduled on each disconnect; cancelled
    /// on reconnect, logout, or unpair.
    private var degradedBannerCheckTimer: Timer?

    public init() {
        // Initialize analytics early so events can be captured throughout the lifecycle
        AnalyticsManager.shared.initialize()

        // Loading account state also performs the one-time legacy Keychain migration.
        refreshAccountsFromKeychain()
        consoleBroker = makeConsoleBroker()
        // Finish console data store removals a previous run could not complete.
        Task { [weak self] in await self?.consoleBroker?.retryPendingRemovals() }

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
    }

    /// Initialize with pre-built managers (for testing and previews).
    public init(databaseManager: DatabaseManager, documentSyncManager: DocumentSyncManager? = nil, syncManager: SyncManager? = nil) {
        self.documentSyncManager = documentSyncManager
        self.databaseManager = databaseManager
        self.syncManager = syncManager
        self.indexLoadState = .loaded
        self.isPaired = true
        self.consoleBroker = makeConsoleBroker()
        #if os(iOS)
        if let syncManager { observeSessionCreation(syncManager) }
        #endif
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
        consoleSelectionChanged()
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
        removeConsoleData(forAccounts: accounts.map(\.id))
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
        consoleSelectionChanged()
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
        recovery.cancel()
        syncManager?.disconnect()
        authManager.logout()
        // clearSyncAuthDegradedState() runs via the $isAuthenticated observer
        // when logout flips isAuthenticated to false.
    }

    /// Request a full index sync from the server.
    public func requestSync() {
        recovery.request(reason: "manual")
    }

    /// Only real background transitions require a fresh connection. Inactive
    /// system overlays do not tear down a healthy session.
    public func setAppInForeground(_ foreground: Bool) {
        #if canImport(UIKit)
        if !foreground { pagesWebController?.sceneDidEnterBackground() }
        #endif
        syncManager?.setAppInForeground(foreground, recover: false)
        documentSyncManager?.setAppInForeground(foreground)
        recovery.setForeground(foreground)
        let checkLater = disconnectClock.setForeground(
            foreground,
            isConnected: isConnected || !authManager.isAuthenticated,
            at: Date()
        )
        if checkLater {
            scheduleDegradedBannerCheck()
        } else if !foreground {
            degradedBannerCheckTimer?.invalidate()
            degradedBannerCheckTimer = nil
        }
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

        // Sign-out journals the account's console store in the same call stack
        // as `logout()`, not a run-loop turn later.
        authManager.$isAuthenticated
            .dropFirst()
            .filter { !$0 }
            .sink { [weak self] _ in
                guard let accountId = KeychainManager.getActiveAccount()?.id else { return }
                self?.consoleBroker?.journalRemovals([accountId])
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
                    // A new session: nothing from the previous one may answer under it.
                    self.consoleSelectionChanged()
                    AnalyticsManager.shared.capture("mobile_login_completed")
                    self.setupManagersIfNeeded()
                    self.connectIfReady()
                    self.warmupTranscriptWebViewIfAppropriate()
                } else {
                    // Auth lost for the selected account: no rooms or database
                    // observations from that account may remain live.
                    self.tearDownManagers()
                    // Nor its console session: drop the web view and its data store.
                    self.removeConsoleData(forAccounts: KeychainManager.getActiveAccount().map { [$0.id] } ?? [])
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
        recovery.configure(identity: KeychainManager.getActiveAccount()?.id)
        recovery.request(reason: "credentials")
    }

    private func performSyncRecovery() async -> Bool {
        guard isPaired, authManager.isAuthenticated,
              let accountId = KeychainManager.getActiveAccount()?.id,
              let sync = syncManager else { return false }
        sync.prepareForRecovery()
        guard let jwt = await SyncCredentials.freshToken(
            read: { self.authManager.sessionJwt },
            isCurrent: { accountId == KeychainManager.getActiveAccount()?.id && self.syncManager === sync && self.authManager.isAuthenticated },
            refresh: { await self.refreshJWT() }
        ), let authUserId = authManager.authUserId else { return false }

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
        } else if let extracted = SyncCredentials.orgId(from: jwt) {
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
            return false
        }

        logger.info("Connecting to sync server")
        sync.connect(authToken: jwt, authUserId: effectiveAuthUserId, orgId: orgId)

        // Pass auth credentials to DocumentSyncManager for project room connections
        documentSyncManager?.setAuth(authToken: jwt, authUserId: effectiveAuthUserId, orgId: orgId, reconnect: true)

        startJWTRefreshTimer()
        return await sync.waitForConnection()
    }

    // MARK: - Console sessions

    private func makeConsoleBroker() -> ConsoleSessionBroker {
        ConsoleSessionBroker(
            credentials: ConsoleCredentials(
                account: { [weak self] in self?.currentConsoleAccount() },
                // The personal JWT of exactly `context`, refreshed through the
                // same path sync uses. Nil once the selection moved on, before or
                // after the refresh. The broker can read it; nothing writes the account.
                personalJwt: { [weak self] context in
                    guard let self, self.currentConsoleAccount() == context else { return nil }
                    return await SyncCredentials.freshToken(
                        read: { self.authManager.sessionJwt },
                        isCurrent: { self.currentConsoleAccount() == context },
                        refresh: { await self.refreshJWT() }
                    )
                }
            ),
            dataStores: WebKitConsoleDataStores()
        )
    }

    func currentConsoleAccount() -> ConsoleAccountContext? {
        guard authManager.isAuthenticated,
              let account = KeychainManager.getActiveAccount(),
              let apiBase = ConsoleAccountContext.apiBase(fromServerUrl: account.serverUrl) else { return nil }
        return ConsoleAccountContext(accountId: account.id, apiBase: apiBase, generation: consoleGeneration)
    }

    /// Every pairing, switch, sign-in and sign-out: drop the web view, move to a
    /// new generation, and cancel directory work captured under the old one.
    func consoleSelectionChanged() {
        tearDownPages()
        consoleGeneration &+= 1
        consoleBroker?.selectionChanged()
    }

    /// Sign-out or unpair. The web view is torn down and released first, its
    /// bridge work cancelled (WebKit will not remove a store in use); the
    /// removal is recorded before it runs and retried until it succeeds.
    func removeConsoleData(forAccounts accountIds: [String]) {
        // Journal every affected store first, in one synchronous write: a
        // process death after this point still removes them at next launch.
        consoleBroker?.journalRemovals(accountIds)
        consoleSelectionChanged()
        guard let broker = consoleBroker, !accountIds.isEmpty else { return }
        Task { @MainActor in
            // Let SwiftUI drop the detail that still holds the old controller.
            await Task.yield()
            for accountId in accountIds { await broker.accountSignedOut(accountId) }
        }
    }

    func tearDownPages() {
        #if canImport(UIKit)
        guard let controller = pagesWebController else { return }
        controller.tearDown()
        pagesWebController = nil
        objectWillChange.send()
        #endif
    }

    // MARK: - JWT Refresh

    /// Stytch JWTs expire after ~5 minutes. Refresh every 4 minutes to stay connected.
    private func startJWTRefreshTimer() {
        jwtRefreshTimer?.invalidate()
        jwtRefreshTimer = Timer.scheduledTimer(withTimeInterval: 4 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.recovery.request(reason: "credential timer") }
        }
    }

    private func refreshJWT() async -> Bool {
        guard let serverUrl = KeychainManager.getServerUrl() else { return false }
        let result = await authManager.refreshSession(serverUrl: serverUrl)
        guard !Task.isCancelled else { return false }
        switch result {
        case .success:
            consecutiveRefreshFailures = 0
            lastCountedRefreshFailure = nil
            return true
        case .accountChanged:
            // A switch already rebuilt (or will rebuild) the selected account.
            // The old in-flight refresh must not affect its failure counters.
            return false
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
            // Lifecycle/network retries must not turn the four-minute auth
            // escalation cadence into a rapid logout during a transient outage.
            if let last = lastCountedRefreshFailure, Date().timeIntervalSince(last) < 4 * 60 { return false }
            lastCountedRefreshFailure = Date()
            consecutiveRefreshFailures += 1
            let count = consecutiveRefreshFailures
            logger.warning("JWT refresh failed (transient, \(count) consecutive)")

            if count >= AppState.refreshFailureEscalationThreshold {
                logger.error("JWT refresh has failed \(count) consecutive times; escalating to sessionExpired")
                handleSessionExpired(reason: "Your session could not be refreshed. Please sign in again.")
                return false
            }
            if count >= AppState.refreshFailureBannerThreshold && !syncAuthDegraded {
                logger.warning("Surfacing degraded banner after \(count) consecutive refresh failures")
                syncAuthDegraded = true
            }
        }
        return false
    }

    /// Tear down the JWT refresh timer, disconnect sync, log the user out,
    /// and surface a reason on the login screen. Shared between the
    /// AuthManager-reported `.sessionExpired` path and the consecutive-failure
    /// escalation path.
    private func handleSessionExpired(reason: String) {
        jwtRefreshTimer?.invalidate()
        jwtRefreshTimer = nil
        recovery.cancel()
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
        disconnectClock.connected()
        degradedBannerCheckTimer?.invalidate()
        degradedBannerCheckTimer = nil
        if syncAuthDegraded {
            syncAuthDegraded = false
        }
    }

    /// Called whenever the sync manager's connection state changes.
    /// On reconnect we clear all degraded-state tracking. On disconnect
    /// (while authenticated) we record the timestamp and schedule a one-shot
    /// re-evaluation one foreground threshold out (see `SustainedDisconnectClock`).
    private func handleSyncConnectionChange(connected: Bool) {
        if connected {
            clearSyncAuthDegradedState()
            return
        }
        guard authManager.isAuthenticated else { return }
        disconnectClock.disconnected(at: Date())
        scheduleDegradedBannerCheck()
    }

    private func scheduleDegradedBannerCheck() {
        degradedBannerCheckTimer?.invalidate()
        degradedBannerCheckTimer = Timer.scheduledTimer(
            withTimeInterval: disconnectClock.threshold,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.evaluateDegradedBanner()
            }
        }
    }

    /// Fires one threshold after a foreground disconnect-while-authed.
    /// If we're still disconnected and still authenticated, surface the
    /// banner. The user can then either tap "Sign in again" or wait for the
    /// refresh-failure escalation path (~20 min) to log them out automatically.
    private func evaluateDegradedBanner() {
        guard authManager.isAuthenticated else { return }
        guard disconnectClock.isSustained(at: Date(), isConnected: isConnected),
              let since = disconnectClock.disconnectedSince else {
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
        sync.setAppInForeground(recovery.isForeground, recover: false)
        sync.onReconnectNeeded = { [weak self] in self?.recovery.connectionFailed() }
        recovery.configure(identity: account.id)
        if networkObserver == nil {
            networkObserver = SyncNetworkObserver { [weak self] in self?.recovery.request(reason: "network") }
        }
        sync.$indexLoadState
            .sink { [weak self] state in self?.indexLoadState = state }
            .store(in: &managerCancellables)

        // Initialize DocumentSyncManager for project file sync
        let docSync = DocumentSyncManager(crypto: crypto, database: database, serverUrl: serverUrl, userId: keyUserId)
        documentSyncManager = docSync
        docSync.setAppInForeground(recovery.isForeground)

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
            .removeDuplicates()
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

        // SyncManager only delivers successes for this device's pending requests.
        // Open sessions created by the toolbar as well as those created by voice.
        observeSessionCreation(sync)

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
        recovery.cancel()
        lastCountedRefreshFailure = nil
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
        indexLoadState = .loading
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

    // MARK: - Screenshot Mode

    #if DEBUG
    /// Create an AppState configured for screenshot capture.
    /// Uses an in-memory database with realistic demo data, bypasses auth/pairing.
    public static func forScreenshots() -> AppState {
        let historyCount = CommandLine.arguments.contains("--retained-history-fixture") ? 10_000 : 0
        let db = try! ScreenshotDataProvider.createPopulatedDatabase(historyCount: historyCount)
        let state = AppState(databaseManager: db)
        state.isConnected = true
        state.screenshotMode = true
        #if canImport(UIKit)
        state.applyConsolePagesFixture()
        #endif
        return state
    }
    #endif
}
