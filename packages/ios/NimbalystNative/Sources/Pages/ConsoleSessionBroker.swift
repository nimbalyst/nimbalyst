import Foundation
import CryptoKit
import os

/// The account a console session is minted for, and where its API lives.
///
/// `generation` changes on every pairing, account switch, sign-in and
/// sign-out. Two contexts are equal only if they belong to the same
/// selection, so work captured under one selection can never act under the next.
public struct ConsoleAccountContext: Equatable, Sendable {
    public let accountId: String
    /// `https://<sync host>`: the account's server URL with ws(s) mapped to http(s).
    public let apiBase: URL
    public let generation: UInt64

    public init(accountId: String, apiBase: URL, generation: UInt64 = 0) {
        self.accountId = accountId
        self.apiBase = apiBase
        self.generation = generation
    }

    /// Map a stored `wss://...` server URL to its HTTP base.
    public static func apiBase(fromServerUrl serverUrl: String) -> URL? {
        let base = serverUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: base), url.scheme == "https" || url.scheme == "http", url.host != nil else { return nil }
        return url
    }
}

/// How the broker reads the selected account. It has no way to write one:
/// a mint must never store into, or rotate, the account's own session.
@MainActor
public struct ConsoleCredentials {
    public var account: @MainActor () -> ConsoleAccountContext?
    /// The personal JWT for exactly `context`, not about to expire, or nil
    /// when `context` is no longer the current selection (before or after a refresh).
    public var personalJwt: @MainActor (ConsoleAccountContext) async -> String?

    public init(
        account: @escaping @MainActor () -> ConsoleAccountContext?,
        personalJwt: @escaping @MainActor (ConsoleAccountContext) async -> String?
    ) {
        self.account = account
        self.personalJwt = personalJwt
    }
}

/// Removes a per-account WebKit data store. Production uses
/// `WKWebsiteDataStore.remove(forIdentifier:)`.
@MainActor
public protocol ConsoleWebDataStoreRemoving: AnyObject {
    func removeDataStore(identifier: UUID) async throws
}

/// Accounts whose console data store must be removed before it is used again.
/// Journaled synchronously, before any yield, credential deletion or removal
/// attempt, so a failure or a process death mid-removal is retried at next
/// launch and before the next Pages open for that account.
///
/// Only stores that were actually created are journaled: an account that never
/// opened Pages has nothing to remove and must never be blocked by one.
public struct ConsoleStoreRemovalLedger: @unchecked Sendable {
    static let key = "consolePages.pendingStoreRemovals"
    static let createdKey = "consolePages.createdStores"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var accountIds: [String] { defaults.stringArray(forKey: Self.key) ?? [] }
    var createdAccountIds: [String] { defaults.stringArray(forKey: Self.createdKey) ?? [] }

    public func contains(_ accountId: String) -> Bool { accountIds.contains(accountId) }

    /// Recorded before the store is first created, so a crash cannot leave an unrecorded store.
    func markCreated(_ accountId: String) {
        guard !createdAccountIds.contains(accountId) else { return }
        defaults.set(createdAccountIds + [accountId], forKey: Self.createdKey)
    }

    /// Journal every created store among `accountIds` in one write.
    func journal(_ accountIds: [String]) {
        let created = Set(createdAccountIds)
        let added = accountIds.filter { created.contains($0) && !contains($0) }
        guard !added.isEmpty else { return }
        defaults.set(self.accountIds + added, forKey: Self.key)
    }

    func removed(_ accountId: String) {
        defaults.set(accountIds.filter { $0 != accountId }, forKey: Self.key)
        defaults.set(createdAccountIds.filter { $0 != accountId }, forKey: Self.createdKey)
    }
}

public struct ConsoleSessionTokens: Equatable, Sendable {
    public let orgId: String
    public let sessionToken: String
    public let sessionJwt: String
}

/// The error codes `deliverSession` accepts (`nativeSession.ts`).
public enum ConsoleSessionDeliveryError: String, Equatable, Sendable {
    case orgAuthRequired = "org_auth_required"
    case notAMember = "not_a_member"
    case unavailable
    case failed
}

public enum ConsoleMintOutcome: Equatable, Sendable {
    case minted(ConsoleSessionTokens)
    case refused(ConsoleSessionDeliveryError, orgId: String?, reason: String?)
}

/// One answer to a console `requestSession` / `sessionExpired`.
public struct ConsoleSessionDelivery: Equatable, Sendable {
    public let requestId: String
    public let outcome: ConsoleMintOutcome
    /// The selection this answer was minted under. Delivered only while it is current.
    public let account: ConsoleAccountContext?

    public init(requestId: String, outcome: ConsoleMintOutcome, account: ConsoleAccountContext? = nil) {
        self.requestId = requestId
        self.outcome = outcome
        self.account = account
    }

    /// The argument to `window.__nimbalystConsoleBridge.deliverSession`. Passed
    /// as a `callAsyncJavaScript` argument, never interpolated into source or a URL.
    public var payload: [String: String] {
        switch outcome {
        case .minted(let tokens):
            return ["requestId": requestId, "orgId": tokens.orgId, "sessionToken": tokens.sessionToken, "sessionJwt": tokens.sessionJwt]
        case .refused(let error, let orgId, let reason):
            var payload = ["requestId": requestId, "error": error.rawValue]
            if let orgId { payload["orgId"] = orgId }
            if let reason { payload["reason"] = reason }
            return payload
        }
    }
}

public enum ConsoleTeamsOutcome: Equatable, Sendable {
    case loaded([ConsoleTeamSummary])
    case failed(String)
}

/// Mints console sessions for the Pages web view and owns its per-account
/// web data store. Owned by `AppState`, never by a view.
///
/// The personal JWT goes to exactly two places: the mint route and
/// `GET /api/teams`. Minted tokens go to exactly one: the console's
/// `deliverSession`, in the web view of the selection they were minted for.
/// Nothing here caches a minted token; every console request is one mint.
@MainActor
public final class ConsoleSessionBroker {
    public static let mintPath = "/auth/console-session"
    public static let teamsPath = "/api/teams"
    static let requestTimeout: TimeInterval = 15

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "ConsolePages")
    private let credentials: ConsoleCredentials
    private let urlSession: URLSession
    private let dataStores: ConsoleWebDataStoreRemoving
    private let teamsTTL: TimeInterval
    private let now: () -> Date
    private let removalRetryDelays: [Duration]
    private var teamsCache: (account: ConsoleAccountContext, fetchedAt: Date, teams: [ConsoleTeamSummary])?
    private var teamsInFlight: (account: ConsoleAccountContext, task: Task<ConsoleTeamsOutcome, Never>)?
    /// Request ids already answered. A console request is one mint, never two.
    private var answeredRequestIds: [String] = []
    public let orgChoices: ConsoleOrgChoiceStore
    public let pendingRemovals: ConsoleStoreRemovalLedger

    public init(
        credentials: ConsoleCredentials,
        dataStores: ConsoleWebDataStoreRemoving,
        urlSession: URLSession = ConsoleSessionBroker.makeURLSession(),
        orgChoices: ConsoleOrgChoiceStore = ConsoleOrgChoiceStore(),
        pendingRemovals: ConsoleStoreRemovalLedger = ConsoleStoreRemovalLedger(),
        removalRetryDelays: [Duration] = [.milliseconds(300), .seconds(1), .seconds(2)],
        teamsTTL: TimeInterval = 120,
        now: @escaping () -> Date = Date.init
    ) {
        self.credentials = credentials
        self.dataStores = dataStores
        self.urlSession = urlSession
        self.orgChoices = orgChoices
        self.pendingRemovals = pendingRemovals
        self.removalRetryDelays = removalRetryDelays
        self.teamsTTL = teamsTTL
        self.now = now
    }

    /// No cookies, no cache: neither a bearer JWT nor a minted token may be persisted by URLSession.
    public nonisolated static func makeURLSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }

    /// True while `context` is still the selected account and generation.
    public func isCurrent(_ context: ConsoleAccountContext) -> Bool {
        credentials.account() == context
    }

    /// Every pairing, switch, sign-in and sign-out: nothing captured before
    /// it may complete after it.
    public func selectionChanged() {
        teamsInFlight?.task.cancel()
        teamsInFlight = nil
        teamsCache = nil
        answeredRequestIds.removeAll()
    }

    // MARK: - Web data store

    /// A stable identifier for one account's console data store. Derived, so it
    /// survives relaunch without being stored anywhere.
    public nonisolated static func dataStoreIdentifier(forAccount accountId: String) -> UUID {
        var bytes = Array(SHA256.hash(data: Data("nimbalyst-console-store:\(accountId)".utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50 // version 5 style
        bytes[8] = (bytes[8] & 0x3F) | 0x80 // RFC 4122 variant
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    /// Sign-out or account removal: drop the account's console cookies,
    /// localStorage and team choices. The caller has already torn down and
    /// released the web view using the store. The removal is recorded first and
    /// retried; a store that still could not be removed stays in the ledger.
    @discardableResult
    public func accountSignedOut(_ accountId: String) async -> Bool {
        selectionChanged()
        orgChoices.forgetAccount(accountId)
        pendingRemovals.journal([accountId])
        guard pendingRemovals.contains(accountId) else { return true }
        return await removeStore(accountId, delays: removalRetryDelays)
    }

    /// Synchronously record that these accounts' stores must go. Call before
    /// yielding, deleting credentials, or attempting any removal.
    public func journalRemovals(_ accountIds: [String]) {
        pendingRemovals.journal(accountIds)
    }

    /// The store for `accountId` is about to be created.
    public func noteStoreCreated(forAccount accountId: String) {
        pendingRemovals.markCreated(accountId)
    }

    /// Before a store identifier is used again: a removal still pending for it
    /// must succeed first. Returns false when it still cannot be removed.
    public func prepareStore(forAccount accountId: String) async -> Bool {
        guard pendingRemovals.contains(accountId) else { return true }
        return await removeStore(accountId, delays: [])
    }

    /// At launch: finish removals a previous run could not.
    public func retryPendingRemovals() async {
        for accountId in pendingRemovals.accountIds {
            await removeStore(accountId, delays: [])
        }
    }

    @discardableResult
    private func removeStore(_ accountId: String, delays: [Duration]) async -> Bool {
        let identifier = Self.dataStoreIdentifier(forAccount: accountId)
        var lastError: Error?
        for attempt in 0...delays.count {
            if attempt > 0 { try? await Task.sleep(for: delays[attempt - 1]) }
            do {
                try await dataStores.removeDataStore(identifier: identifier)
                pendingRemovals.removed(accountId)
                logger.info("Removed console data store for a signed-out account")
                return true
            } catch {
                lastError = error
            }
        }
        logger.error("Console data store removal failed; will retry before reuse: \(lastError?.localizedDescription ?? "unknown")")
        return false
    }

    // MARK: - Sessions

    /// Answer one console session request from the web view bound to `account`.
    /// Returns nil for a duplicate request id (it never mints twice) and for a
    /// web view whose selection is no longer current (its request is dropped).
    /// `orgId` nil means "the session expired and the page does not know its
    /// org"; `fallbackOrgId` is the org of the page native opened.
    public func answer(requestId: String, orgId: String?, fallbackOrgId: String?, for account: ConsoleAccountContext) async -> ConsoleSessionDelivery? {
        guard isCurrent(account) else {
            logger.warning("Dropping a console session request from a stale account selection")
            return nil
        }
        guard !answeredRequestIds.contains(requestId) else {
            logger.info("Ignoring duplicate console session request")
            return nil
        }
        answeredRequestIds.append(requestId)
        if answeredRequestIds.count > 64 { answeredRequestIds.removeFirst(answeredRequestIds.count - 64) }
        guard let target = orgId ?? fallbackOrgId else {
            return ConsoleSessionDelivery(requestId: requestId, outcome: .refused(.failed, orgId: nil, reason: "unknown_org"), account: account)
        }
        let outcome = await mint(orgId: target, for: account)
        guard isCurrent(account) else { return nil }
        return ConsoleSessionDelivery(requestId: requestId, outcome: outcome, account: account)
    }

    /// `POST /auth/console-session {orgId}` with `account`'s personal JWT. One
    /// call, one outcome; the caller decides what to show.
    public func mint(orgId: String, for account: ConsoleAccountContext) async -> ConsoleMintOutcome {
        guard isCurrent(account) else {
            return .refused(.failed, orgId: orgId, reason: credentials.account() == nil ? "signed_out" : "account_changed")
        }
        guard let jwt = await credentials.personalJwt(account) else {
            return .refused(.failed, orgId: orgId, reason: isCurrent(account) ? "personal_session_unavailable" : "account_changed")
        }
        guard isCurrent(account) else {
            return .refused(.failed, orgId: orgId, reason: "account_changed")
        }
        var request = URLRequest(url: account.apiBase.appendingPathComponent(String(Self.mintPath.dropFirst())))
        request.httpMethod = "POST"
        request.timeoutInterval = Self.requestTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["orgId": orgId])

        let outcome: ConsoleMintOutcome
        do {
            let (data, response) = try await urlSession.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            outcome = Self.mintOutcome(status: status, body: data, requestedOrgId: orgId)
        } catch {
            logger.warning("Console session mint transport failed: \(error.localizedDescription)")
            outcome = .refused(.failed, orgId: orgId, reason: (error as? URLError)?.code == .timedOut ? "timeout" : "network")
        }
        // A switch while the request was in flight: the answer belongs to the old selection.
        guard isCurrent(account) else {
            return .refused(.failed, orgId: orgId, reason: "account_changed")
        }
        if case .refused(let code, _, let reason) = outcome {
            logger.warning("Console session mint refused: \(code.rawValue) \(reason ?? "")")
        }
        return outcome
    }

    /// Mint for whichever account is selected now (tests and diagnostics).
    public func mint(orgId: String) async -> ConsoleMintOutcome {
        guard let account = credentials.account() else {
            return .refused(.failed, orgId: orgId, reason: "signed_out")
        }
        return await mint(orgId: orgId, for: account)
    }

    /// The route's responses (`collabv3/src/consoleSession.ts`) mapped to the
    /// codes `deliverSession` accepts. Pure.
    nonisolated static func mintOutcome(status: Int, body: Data, requestedOrgId: String) -> ConsoleMintOutcome {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let error = json["error"] as? String
        switch status {
        case 200:
            guard let token = json["sessionToken"] as? String, !token.isEmpty,
                  let sessionJwt = json["sessionJwt"] as? String, !sessionJwt.isEmpty,
                  let orgId = json["orgId"] as? String, orgId == requestedOrgId else {
                return .refused(.failed, orgId: requestedOrgId, reason: "malformed_response")
            }
            return .minted(ConsoleSessionTokens(orgId: orgId, sessionToken: token, sessionJwt: sessionJwt))
        case 403:
            switch error {
            case "org_auth_required":
                // Every reason (mfa_required, primary_auth_required,
                // member_mfa_enrolled, auth_method_not_allowed,
                // org_policy_unknown) is the same answer to the reader.
                return .refused(.orgAuthRequired, orgId: requestedOrgId, reason: json["reason"] as? String)
            case "not_a_member":
                return .refused(.notAMember, orgId: requestedOrgId, reason: nil)
            default:
                // personal_scope_required, not_a_team_org, or an unknown refusal.
                return .refused(.failed, orgId: requestedOrgId, reason: error ?? "forbidden")
            }
        case 503:
            return .refused(.unavailable, orgId: requestedOrgId, reason: error)
        case 401:
            return .refused(.failed, orgId: requestedOrgId, reason: "unauthorized")
        default:
            return .refused(.failed, orgId: requestedOrgId, reason: error ?? "http_\(status)")
        }
    }

    // MARK: - Teams

    /// `GET /api/teams`, cached per selection for a short TTL. Failures are not
    /// cached. A result that arrives after a selection change is discarded.
    public func teams(forceRefresh: Bool = false) async -> ConsoleTeamsOutcome {
        guard let account = credentials.account() else { return .failed("signed_out") }
        if !forceRefresh, let cache = teamsCache, cache.account == account,
           now().timeIntervalSince(cache.fetchedAt) < teamsTTL {
            return .loaded(cache.teams)
        }
        if let inFlight = teamsInFlight, inFlight.account == account {
            return await inFlight.task.value
        }
        let task = Task { @MainActor in await self.fetchTeams(account: account) }
        teamsInFlight = (account, task)
        let outcome = await task.value
        if teamsInFlight?.account == account { teamsInFlight = nil }
        guard isCurrent(account) else { return .failed("account_changed") }
        if case .loaded(let teams) = outcome {
            teamsCache = (account, now(), teams)
        }
        return outcome
    }

    /// The org the user picked for a project shared in several orgs.
    public func rememberedOrgId(forProjectId projectId: String) -> String? {
        guard let account = credentials.account() else { return nil }
        return orgChoices.orgId(accountId: account.accountId, projectId: projectId)
    }

    public func rememberOrgChoice(_ orgId: String, forProjectId projectId: String) {
        guard let account = credentials.account() else { return }
        orgChoices.remember(orgId: orgId, accountId: account.accountId, projectId: projectId)
    }

    private func fetchTeams(account: ConsoleAccountContext) async -> ConsoleTeamsOutcome {
        guard let jwt = await credentials.personalJwt(account), isCurrent(account), !Task.isCancelled else {
            return .failed(isCurrent(account) ? "personal_session_unavailable" : "account_changed")
        }
        var request = URLRequest(url: account.apiBase.appendingPathComponent(String(Self.teamsPath.dropFirst())))
        request.httpMethod = "GET"
        request.timeoutInterval = Self.requestTimeout
        request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await urlSession.data(for: request)
            guard isCurrent(account), !Task.isCancelled else { return .failed("account_changed") }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                logger.warning("Team directory request failed: HTTP \(status)")
                return .failed("http_\(status)")
            }
            let decoded = try JSONDecoder().decode(ConsoleTeamsResponse.self, from: data)
            return .loaded(decoded.teams)
        } catch {
            logger.warning("Team directory request failed: \(error.localizedDescription)")
            return .failed(isCurrent(account) ? "network" : "account_changed")
        }
    }
}
