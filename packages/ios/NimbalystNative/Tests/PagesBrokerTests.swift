import XCTest
@testable import NimbalystNative

/// Records every request and answers from a per-path script.
private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Recorded { let url: URL; let method: String; let authorization: String?; let body: Data? }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _requests: [Recorded] = []
    nonisolated(unsafe) private static var _responses: [String: (Int, Data)] = [:]
    /// Hold every response this long, so a test can switch accounts mid-flight.
    nonisolated(unsafe) static var delay: TimeInterval = 0

    static var requests: [Recorded] { lock.withLock { _requests } }
    static func reset(_ responses: [String: (Int, Any)]) {
        lock.withLock {
            _requests = []
            delay = 0
            _responses = responses.mapValues { ($0.0, try! JSONSerialization.data(withJSONObject: $0.1)) }
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            body = data
        }
        let url = request.url!
        let (status, data) = Self.lock.withLock {
            Self._requests.append(Recorded(url: url, method: request.httpMethod ?? "GET", authorization: request.value(forHTTPHeaderField: "Authorization"), body: body))
            return Self._responses[url.path] ?? (404, Data("{}".utf8))
        }
        let respond = { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
        let delay = Self.lock.withLock { Self.delay }
        if delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: respond) } else { respond() }
    }

    override func stopLoading() {}
}

@MainActor
private final class FakeDataStores: ConsoleWebDataStoreRemoving {
    var removed: [UUID] = []
    /// WebKit refuses while a web view still uses the store.
    var failuresRemaining = 0
    var attempts = 0
    func removeDataStore(identifier: UUID) async throws {
        attempts += 1
        if failuresRemaining > 0 {
            failuresRemaining -= 1
            throw URLError(.cannotRemoveFile)
        }
        removed.append(identifier)
    }
}

@MainActor
final class PagesBrokerTests: XCTestCase {
    private let personalJwt = "personal.jwt.value"
    /// The account's own session token. A mint must never send, store or rotate it.
    private let accountSessionToken = "account-session-token"
    private var account: ConsoleAccountContext? = ConsoleAccountContext(accountId: "acct-1", apiBase: URL(string: "https://sync.example")!)
    private var dataStores = FakeDataStores()
    /// Runs inside the JWT read, before it returns: a switch "during refresh".
    private var duringJwtRead: (() -> Void)?

    private func makeBroker(defaults: UserDefaults = UserDefaults(suiteName: UUID().uuidString)!) -> ConsoleSessionBroker {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return ConsoleSessionBroker(
            credentials: ConsoleCredentials(
                account: { [weak self] in self?.account },
                // Same contract as AppState: the JWT of exactly `context`, or nil once it is not current.
                personalJwt: { [weak self] context in
                    guard let self, self.account == context else { return nil }
                    self.duringJwtRead?()
                    guard self.account == context else { return nil }
                    return context.accountId == "acct-1" ? self.personalJwt : "\(context.accountId).jwt"
                }
            ),
            dataStores: dataStores,
            urlSession: URLSession(configuration: configuration),
            orgChoices: ConsoleOrgChoiceStore(defaults: defaults),
            pendingRemovals: ConsoleStoreRemovalLedger(defaults: defaults),
            removalRetryDelays: [.zero, .zero]
        )
    }

    private func switchAccount(to id: String, generation: UInt64 = 1) {
        account = ConsoleAccountContext(accountId: id, apiBase: URL(string: "https://\(id).example")!, generation: generation)
    }

    private let minted: [String: Any] = [
        "sessionToken": "minted-token", "sessionJwt": "minted.jwt", "orgId": "organization-team",
        "memberId": "member-1", "expiresAt": "2026-10-16T00:00:00Z",
    ]

    func testMintSendsOnlyOrgIdAndDeliversTokensOutsideAnyURL() async throws {
        StubURLProtocol.reset(["/auth/console-session": (200, minted)])
        let broker = makeBroker()
        let delivery = await broker.answer(requestId: "r1", orgId: "organization-team", fallbackOrgId: nil, for: account!)

        XCTAssertEqual(delivery?.payload, ["requestId": "r1", "orgId": "organization-team", "sessionToken": "minted-token", "sessionJwt": "minted.jwt"])
        let requests = StubURLProtocol.requests
        XCTAssertEqual(requests.count, 1)
        let mint = try XCTUnwrap(requests.first)
        XCTAssertEqual(mint.method, "POST")
        XCTAssertEqual(mint.url.absoluteString, "https://sync.example/auth/console-session")
        XCTAssertEqual(mint.authorization, "Bearer \(personalJwt)")
        let body = try XCTUnwrap(mint.body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: String] })
        XCTAssertEqual(body, ["orgId": "organization-team"], "the account's session token is never sent")
        for request in requests {
            for secret in ["minted-token", "minted.jwt", personalJwt, accountSessionToken] {
                XCTAssertFalse(request.url.absoluteString.contains(secret), "no credential in a URL")
            }
        }
        XCTAssertEqual(accountSessionToken, "account-session-token")
        XCTAssertEqual(account?.accountId, "acct-1", "a mint does not touch the selected account")
    }

    func testOneMintPerRequestIdAndOnePerExpiry() async {
        StubURLProtocol.reset(["/auth/console-session": (200, minted)])
        let broker = makeBroker()
        _ = await broker.answer(requestId: "r1", orgId: nil, fallbackOrgId: "organization-team", for: account!)
        let duplicate = await broker.answer(requestId: "r1", orgId: nil, fallbackOrgId: "organization-team", for: account!)
        XCTAssertNil(duplicate, "a repeated post of one request never mints twice")
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        _ = await broker.answer(requestId: "r2", orgId: "organization-team", fallbackOrgId: nil, for: account!)
        XCTAssertEqual(StubURLProtocol.requests.count, 2, "a new sessionExpired re-mints exactly once")
    }

    func testRefusalsMapToDeliveryErrors() {
        func outcome(_ status: Int, _ body: [String: Any]) -> ConsoleMintOutcome {
            ConsoleSessionBroker.mintOutcome(status: status, body: try! JSONSerialization.data(withJSONObject: body), requestedOrgId: "organization-team")
        }
        XCTAssertEqual(outcome(403, ["error": "org_auth_required", "orgId": "organization-team", "reason": "mfa_required"]),
                       .refused(.orgAuthRequired, orgId: "organization-team", reason: "mfa_required"))
        XCTAssertEqual(outcome(403, ["error": "org_auth_required", "orgId": "organization-team", "reason": "primary_auth_required"]),
                       .refused(.orgAuthRequired, orgId: "organization-team", reason: "primary_auth_required"))
        XCTAssertEqual(outcome(403, ["error": "not_a_member"]), .refused(.notAMember, orgId: "organization-team", reason: nil))
        XCTAssertEqual(outcome(403, ["error": "not_a_team_org"]), .refused(.failed, orgId: "organization-team", reason: "not_a_team_org"))
        XCTAssertEqual(outcome(403, ["error": "personal_scope_required"]), .refused(.failed, orgId: "organization-team", reason: "personal_scope_required"))
        XCTAssertEqual(outcome(503, ["error": "console_session_unavailable"]), .refused(.unavailable, orgId: "organization-team", reason: "console_session_unavailable"))
        XCTAssertEqual(outcome(502, ["error": "console_session_failed"]), .refused(.failed, orgId: "organization-team", reason: "console_session_failed"))
        XCTAssertEqual(outcome(401, ["error": "unauthorized"]), .refused(.failed, orgId: "organization-team", reason: "unauthorized"))
        // A session for a different org than requested is never delivered.
        XCTAssertEqual(outcome(200, ["sessionToken": "t", "sessionJwt": "j", "orgId": "organization-other"]),
                       .refused(.failed, orgId: "organization-team", reason: "malformed_response"))
        let refused = ConsoleSessionDelivery(requestId: "r", outcome: .refused(.orgAuthRequired, orgId: "o", reason: "mfa_required"))
        XCTAssertEqual(refused.payload, ["requestId": "r", "error": "org_auth_required", "orgId": "o", "reason": "mfa_required"])
    }

    func testPersonalJwtOnlyGoesToMintAndTeams() async {
        StubURLProtocol.reset([
            "/auth/console-session": (403, ["error": "not_a_member"]),
            "/api/teams": (200, ["teams": []]),
        ])
        let broker = makeBroker()
        _ = await broker.mint(orgId: "organization-team")
        _ = await broker.teams()
        XCTAssertEqual(Set(StubURLProtocol.requests.map(\.url.path)), ["/auth/console-session", "/api/teams"])
        XCTAssertTrue(StubURLProtocol.requests.allSatisfy { $0.authorization == "Bearer \(personalJwt)" })
    }

    func testSignedOutMintsNothing() async {
        StubURLProtocol.reset([:])
        account = nil
        let outcome = await makeBroker().mint(orgId: "organization-team")
        XCTAssertEqual(outcome, .refused(.failed, orgId: "organization-team", reason: "signed_out"))
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testSignOutRemovesTheAccountDataStore() async {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let broker = makeBroker(defaults: defaults)
        broker.rememberOrgChoice("organization-team", forProjectId: "/p")
        broker.noteStoreCreated(forAccount: "acct-1")
        let removed = await broker.accountSignedOut("acct-1")
        XCTAssertTrue(removed)
        XCTAssertEqual(dataStores.removed, [ConsoleSessionBroker.dataStoreIdentifier(forAccount: "acct-1")])
        XCTAssertNil(broker.rememberedOrgId(forProjectId: "/p"))
        XCTAssertEqual(ConsoleSessionBroker.dataStoreIdentifier(forAccount: "acct-1"), ConsoleSessionBroker.dataStoreIdentifier(forAccount: "acct-1"))
        XCTAssertNotEqual(ConsoleSessionBroker.dataStoreIdentifier(forAccount: "acct-1"), ConsoleSessionBroker.dataStoreIdentifier(forAccount: "acct-2"))
    }

    // R2-W3: a removal WebKit refuses is recorded first, retried, and must
    // succeed before that store identifier is used again.
    func testRefusedStoreRemovalIsRetriedBeforeReuse() async {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let broker = makeBroker(defaults: defaults)
        broker.noteStoreCreated(forAccount: "acct-1")
        dataStores.failuresRemaining = 5
        let removed = await broker.accountSignedOut("acct-1")
        XCTAssertFalse(removed)
        XCTAssertEqual(dataStores.attempts, 3, "one attempt plus the configured retries")
        XCTAssertEqual(ConsoleStoreRemovalLedger(defaults: defaults).accountIds, ["acct-1"], "persisted for the next launch")

        // Next Pages open for that account: still refused, so it stays blocked.
        let stillBlocked = await broker.prepareStore(forAccount: "acct-1")
        XCTAssertFalse(stillBlocked)
        // Next launch, with the web view long gone: removal succeeds and the ledger clears.
        dataStores.failuresRemaining = 0
        let relaunched = makeBroker(defaults: defaults)
        await relaunched.retryPendingRemovals()
        XCTAssertEqual(dataStores.removed, [ConsoleSessionBroker.dataStoreIdentifier(forAccount: "acct-1")])
        XCTAssertTrue(ConsoleStoreRemovalLedger(defaults: defaults).accountIds.isEmpty)
        let ready = await relaunched.prepareStore(forAccount: "acct-1")
        XCTAssertTrue(ready)
        let otherAccount = await relaunched.prepareStore(forAccount: "acct-2")
        XCTAssertTrue(otherAccount, "an account with nothing pending is ready")
    }

    // R2-W3: unpairing several accounts journals every created store in one
    // synchronous call, before any await, so a process death mid-removal
    // cannot leave a later account's store unrecorded and reusable. An account
    // that never opened Pages is not journaled and never blocked.
    func testUnpairJournalsEveryCreatedStoreBeforeAnyRemoval() async {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let broker = makeBroker(defaults: defaults)
        broker.noteStoreCreated(forAccount: "a")
        broker.noteStoreCreated(forAccount: "b")
        broker.journalRemovals(["a", "b", "never-opened"])
        // No await has happened: this is what a process death right now leaves behind.
        XCTAssertEqual(ConsoleStoreRemovalLedger(defaults: defaults).accountIds, ["a", "b"])
        XCTAssertEqual(dataStores.attempts, 0)

        let neverOpened = await broker.accountSignedOut("never-opened")
        XCTAssertTrue(neverOpened)
        XCTAssertEqual(dataStores.attempts, 0, "nothing to remove for a store never created")
        let ready = await broker.prepareStore(forAccount: "never-opened")
        XCTAssertTrue(ready)

        // Next launch finishes both.
        await makeBroker(defaults: defaults).retryPendingRemovals()
        XCTAssertEqual(Set(dataStores.removed), [ConsoleSessionBroker.dataStoreIdentifier(forAccount: "a"), ConsoleSessionBroker.dataStoreIdentifier(forAccount: "b")])
        XCTAssertTrue(ConsoleStoreRemovalLedger(defaults: defaults).accountIds.isEmpty)
    }

    // R2-W1: a request from a web view of the previous selection mints nothing
    // and delivers nothing, even for the same account re-paired (new generation).
    func testStaleSelectionGetsNoSession() async {
        StubURLProtocol.reset(["/auth/console-session": (200, minted)])
        let broker = makeBroker()
        let old = account!
        switchAccount(to: "acct-1", generation: 7)
        let delivery = await broker.answer(requestId: "r1", orgId: "organization-team", fallbackOrgId: nil, for: old)
        XCTAssertNil(delivery)
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    // R2-W1: a switch while the mint is in flight: the answer is dropped.
    func testSwitchDuringMintDropsTheAnswer() async {
        StubURLProtocol.reset(["/auth/console-session": (200, minted)])
        StubURLProtocol.delay = 0.2
        let broker = makeBroker()
        let original = account!
        async let delivery = broker.answer(requestId: "r1", orgId: "organization-team", fallbackOrgId: nil, for: original)
        while StubURLProtocol.requests.isEmpty { try? await Task.sleep(for: .milliseconds(5)) }
        switchAccount(to: "acct-2")
        let answered = await delivery
        XCTAssertNil(answered, "minted for A, never handed to B's selection")
    }

    // R2-W2: the directory JWT is the captured account's, and a switch during
    // its read sends nothing at all.
    func testSwitchDuringDirectoryJwtReadSendsNothing() async {
        StubURLProtocol.reset(["/api/teams": (200, ["teams": [Any]()])])
        let broker = makeBroker()
        duringJwtRead = { [weak self] in self?.switchAccount(to: "acct-2") }
        let outcome = await broker.teams()
        XCTAssertEqual(outcome, .failed("account_changed"))
        XCTAssertTrue(StubURLProtocol.requests.isEmpty, "B's JWT never goes to A's API base")
    }

    // R2-W2: a switch while the directory request is in flight: the result is
    // discarded, not cached, and B's next read goes to B's own API base.
    func testSwitchDuringDirectoryRequestDiscardsTheResult() async {
        let team: [String: Any] = ["orgId": "organization-team", "name": "Team", "projects": [Any]()]
        StubURLProtocol.reset(["/api/teams": (200, ["teams": [team]])])
        StubURLProtocol.delay = 0.2
        let broker = makeBroker()
        async let first = broker.teams()
        while StubURLProtocol.requests.isEmpty { try? await Task.sleep(for: .milliseconds(5)) }
        switchAccount(to: "acct-2")
        broker.selectionChanged()
        let stale = await first
        XCTAssertEqual(stale, .failed("account_changed"))
        StubURLProtocol.delay = 0
        let fresh = await broker.teams()
        guard case .loaded = fresh else { return XCTFail("B reads its own directory: \(fresh)") }
        let requests = StubURLProtocol.requests
        XCTAssertEqual(requests.last?.url.host, "acct-2.example")
        XCTAssertEqual(requests.last?.authorization, "Bearer acct-2.jwt")
        XCTAssertEqual(requests.first?.authorization, "Bearer \(personalJwt)")
    }

    func testTeamsAreCachedPerAccount() async {
        let team: [String: Any] = ["orgId": "organization-team", "name": "Team", "projects": [Any]()]
        StubURLProtocol.reset(["/api/teams": (200, ["teams": [team]])])
        let broker = makeBroker()
        _ = await broker.teams()
        _ = await broker.teams()
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
        account = ConsoleAccountContext(accountId: "acct-2", apiBase: URL(string: "https://sync.example")!)
        _ = await broker.teams()
        XCTAssertEqual(StubURLProtocol.requests.count, 2, "another account never reads the first account's cache")
    }

    // MARK: - Resolver

    func testResolverMatchesRemoteHashInActiveOrgs() {
        let teams = [
            ConsoleTeamSummary(orgId: "organization-a", name: "A", projects: [
                .init(projectId: "x", teamProjectId: "tp-a", gitRemoteHash: "hash1"),
                .init(projectId: "y", teamProjectId: "tp-other", gitRemoteHash: "hash2"),
            ]),
            ConsoleTeamSummary(orgId: "organization-b", name: "B", membershipType: "invited_member", projects: [
                .init(projectId: "x", teamProjectId: "tp-b", gitRemoteHash: "hash1"),
            ]),
            ConsoleTeamSummary(orgId: "organization-c", name: "C", gitRemoteHash: "hash1", teamProjectId: "tp-legacy"),
        ]
        XCTAssertEqual(ConsoleTeamResolver.matches(gitRemoteHash: "hash1", teams: teams).map(\.id),
                       ["organization-a/tp-a", "organization-c/tp-legacy"])
        XCTAssertEqual(ConsoleTeamResolver.mapping(gitRemoteHash: nil, teams: teams, rememberedOrgId: nil), .unmapped)
        XCTAssertEqual(ConsoleTeamResolver.mapping(gitRemoteHash: "hash2", teams: teams, rememberedOrgId: nil),
                       .mapped(.init(orgId: "organization-a", orgName: "A", teamProjectId: "tp-other")))
        guard case .needsChoice(let choices) = ConsoleTeamResolver.mapping(gitRemoteHash: "hash1", teams: teams, rememberedOrgId: nil) else {
            return XCTFail("two orgs share the remote")
        }
        XCTAssertEqual(choices.count, 2)
        XCTAssertEqual(ConsoleTeamResolver.mapping(gitRemoteHash: "hash1", teams: teams, rememberedOrgId: "organization-c"),
                       .mapped(.init(orgId: "organization-c", orgName: "C", teamProjectId: "tp-legacy")))
        XCTAssertEqual(ConsoleTeamResolver.mapping(gitRemoteHash: "nope", teams: teams, rememberedOrgId: nil), .unmapped)
    }

    func testTeamsResponseDecodesTheDirectoryShape() throws {
        let json = """
        {"teams":[{"orgId":"organization-a","name":"A","gitRemoteHash":null,"teamProjectId":null,"createdAt":"","role":"member",
          "membershipType":"active_member","projects":[{"projectId":"p","teamProjectId":"tp","gitRemoteHash":"h","slug":null,"name":"Repo"}],
          "teamMemberId":"m","owningPersonalOrgId":null}]}
        """
        let decoded = try JSONDecoder().decode(ConsoleTeamsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(ConsoleTeamResolver.matches(gitRemoteHash: "h", teams: decoded.teams).map(\.teamProjectId), ["tp"])
    }
}
