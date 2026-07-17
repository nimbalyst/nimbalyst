import XCTest
@testable import NimbalystNative

final class MobileAccountTests: XCTestCase {
    private final class InMemorySecureStore: MobileAccountSecureStore {
        var values: [String: String]
        var writeCounts: [String: Int] = [:]

        init(values: [String: String] = [:]) {
            self.values = values
        }

        func readValue(forKey key: String) -> String? {
            values[key]
        }

        func writeValue(_ value: String, forKey key: String) throws {
            values[key] = value
            writeCounts[key, default: 0] += 1
        }

        func deleteValue(forKey key: String) {
            values.removeValue(forKey: key)
        }
    }

    func testLegacySingleAccountMigratesToOneActiveAccount() throws {
        let legacy = LegacyMobileAccountRecord(
            email: "first@example.com",
            personalOrgId: "org-first",
            sessionToken: "token-first",
            sessionJwt: "jwt-first",
            stytchUserId: "member-first",
            e2eSeed: "seed-first",
            serverUrl: "wss://sync.example.com"
        )

        let migrated = MobileAccountState.migrating(
            accounts: nil,
            activeAccountId: nil,
            legacy: legacy
        )

        XCTAssertEqual(migrated.accounts.count, 1)
        XCTAssertEqual(migrated.activeAccountId, migrated.accounts[0].id)
        XCTAssertEqual(migrated.activeAccount?.email, legacy.email)
        XCTAssertEqual(migrated.activeAccount?.personalOrgId, legacy.personalOrgId)
        XCTAssertEqual(migrated.activeAccount?.sessionToken, legacy.sessionToken)
        XCTAssertEqual(migrated.activeAccount?.sessionJwt, legacy.sessionJwt)
        XCTAssertEqual(migrated.activeAccount?.stytchUserId, legacy.stytchUserId)
        XCTAssertEqual(migrated.activeAccount?.e2eSeed, legacy.e2eSeed)
        XCTAssertTrue(migrated.activeAccount?.usesLegacyDatabase == true)
    }

    func testPairingSecondDifferentEmailKeepsFirstAndValidatesPerAccount() throws {
        let first = MobileAccount(
            id: "org-first",
            email: "first@example.com",
            personalOrgId: "org-first",
            sessionToken: "token-first",
            sessionJwt: "jwt-first",
            stytchUserId: "member-first",
            e2eSeed: "seed-first",
            serverUrl: "wss://sync.example.com"
        )
        var state = MobileAccountState(accounts: [first], activeAccountId: first.id)

        let second = try state.addOrUpdatePairing(
            email: "second@example.com",
            personalOrgId: "org-second",
            stytchUserId: "member-second",
            e2eSeed: "seed-second",
            serverUrl: "wss://sync.example.com"
        )

        XCTAssertEqual(state.accounts.map(\.email), ["first@example.com", "second@example.com"])
        XCTAssertEqual(state.activeAccountId, second.id)
        XCTAssertNoThrow(try state.validateAuthenticatedEmail("second@example.com"))
        XCTAssertThrowsError(try state.validateAuthenticatedEmail("first@example.com"))
        XCTAssertEqual(state.accounts.first?.sessionToken, "token-first")
        XCTAssertEqual(state.accounts.first?.e2eSeed, "seed-first")
    }

    func testSelectedAccountDefinesDatabaseSyncAndKeyDerivationScope() throws {
        let first = MobileAccount(
            id: "org-first",
            email: "first@example.com",
            personalOrgId: "org-first",
            sessionToken: "token-first",
            sessionJwt: "jwt-first",
            stytchUserId: "member-first",
            e2eSeed: "seed-first",
            serverUrl: "wss://one.example.com"
        )
        let second = MobileAccount(
            id: "org-second",
            email: "second@example.com",
            personalOrgId: "org-second",
            sessionToken: "token-second",
            sessionJwt: "jwt-second",
            stytchUserId: "member-second",
            e2eSeed: "seed-second",
            serverUrl: "wss://two.example.com"
        )
        var state = MobileAccountState(accounts: [first, second], activeAccountId: first.id)

        let change = try state.selectAccount(second.id)

        XCTAssertTrue(change.requiresRuntimeRebuild)
        XCTAssertEqual(change.previousAccountId, first.id)
        XCTAssertEqual(state.runtimeScope?.accountId, second.id)
        XCTAssertEqual(state.runtimeScope?.databaseScopeId, second.id)
        XCTAssertEqual(state.runtimeScope?.personalOrgId, "org-second")
        XCTAssertEqual(state.runtimeScope?.sessionJwt, "jwt-second")
        XCTAssertEqual(state.runtimeScope?.serverUrl, "wss://two.example.com")
        XCTAssertEqual(state.runtimeScope?.e2eSeed, "seed-second")
        XCTAssertEqual(state.runtimeScope?.stytchUserId, "member-second")

        let selectedScope = try XCTUnwrap(state.runtimeScope)
        let selectedCrypto = CryptoManager(
            seed: selectedScope.e2eSeed,
            userId: try XCTUnwrap(selectedScope.stytchUserId)
        )
        let expectedSecondCrypto = CryptoManager(seed: "seed-second", userId: "member-second")
        let firstCrypto = CryptoManager(seed: "seed-first", userId: "member-first")
        let projectId = "/Users/test/selected-account-project"
        let selectedCiphertext = try selectedCrypto.encryptProjectId(projectId)
        XCTAssertEqual(selectedCiphertext, try expectedSecondCrypto.encryptProjectId(projectId))
        XCTAssertNotEqual(selectedCiphertext, try firstCrypto.encryptProjectId(projectId))
    }

    func testKeychainAdapterMigratesLegacyOnceAndSecondLoadIsIdempotent() throws {
        let store = InMemorySecureStore(values: legacyStoreValues())
        let adapter = MobileAccountKeychainAdapter(store: store)

        let firstLoad = adapter.loadAccountState()

        XCTAssertTrue(firstLoad.didMigrateLegacy)
        XCTAssertNil(firstLoad.issue)
        XCTAssertEqual(firstLoad.state.accounts.count, 1)
        XCTAssertEqual(firstLoad.state.activeAccount?.email, "legacy@example.com")
        XCTAssertEqual(store.writeCounts[MobileAccountStorageKey.mobileAccounts.rawValue], 1)
        XCTAssertEqual(store.writeCounts[MobileAccountStorageKey.activeAccountId.rawValue], 1)

        let persistedBlob = try XCTUnwrap(store.values[MobileAccountStorageKey.mobileAccounts.rawValue])
        let secondLoad = adapter.loadAccountState()

        XCTAssertFalse(secondLoad.didMigrateLegacy)
        XCTAssertNil(secondLoad.issue)
        XCTAssertEqual(secondLoad.state, firstLoad.state)
        XCTAssertEqual(store.values[MobileAccountStorageKey.mobileAccounts.rawValue], persistedBlob)
        XCTAssertEqual(store.writeCounts[MobileAccountStorageKey.mobileAccounts.rawValue], 1)
        XCTAssertEqual(store.writeCounts[MobileAccountStorageKey.activeAccountId.rawValue], 1)
    }

    func testKeychainAdapterRecoversCorruptBlobFromLegacyAndPreservesOriginal() throws {
        let corruptBlob = "{ definitely-not-valid-account-json"
        var values = legacyStoreValues()
        values[MobileAccountStorageKey.mobileAccounts.rawValue] = corruptBlob
        let store = InMemorySecureStore(values: values)
        var logs: [String] = []
        let adapter = MobileAccountKeychainAdapter(store: store) { logs.append($0) }

        let result = adapter.loadAccountState()

        XCTAssertEqual(result.issue, .recoveredCorruptBlob)
        XCTAssertFalse(result.requiresExplicitRepair)
        XCTAssertEqual(result.state.activeAccount?.email, "legacy@example.com")
        XCTAssertEqual(
            store.values[MobileAccountStorageKey.corruptAccountsBackup.rawValue],
            corruptBlob
        )
        XCTAssertNotEqual(store.values[MobileAccountStorageKey.mobileAccounts.rawValue], corruptBlob)
        XCTAssertTrue(logs.contains(where: { $0.contains("failed to decode") }))

        let recoveredBlob = store.values[MobileAccountStorageKey.mobileAccounts.rawValue]
        _ = adapter.loadAccountState()
        XCTAssertEqual(store.values[MobileAccountStorageKey.mobileAccounts.rawValue], recoveredBlob)
        XCTAssertEqual(store.writeCounts[MobileAccountStorageKey.corruptAccountsBackup.rawValue], 1)
        XCTAssertEqual(store.writeCounts[MobileAccountStorageKey.mobileAccounts.rawValue], 1)
    }

    func testKeychainAdapterSurfacesUnrecoverableCorruptBlobWithoutOverwritingIt() {
        let corruptBlob = "not-json"
        let store = InMemorySecureStore(values: [
            MobileAccountStorageKey.mobileAccounts.rawValue: corruptBlob,
        ])
        var logs: [String] = []
        let adapter = MobileAccountKeychainAdapter(store: store) { logs.append($0) }

        let result = adapter.loadAccountState()

        XCTAssertEqual(result.issue, .corruptBlobUnrecoverable)
        XCTAssertTrue(result.requiresExplicitRepair)
        XCTAssertTrue(result.state.accounts.isEmpty)
        XCTAssertEqual(store.values[MobileAccountStorageKey.mobileAccounts.rawValue], corruptBlob)
        XCTAssertNil(store.writeCounts[MobileAccountStorageKey.mobileAccounts.rawValue])
        XCTAssertTrue(logs.contains(where: { $0.contains("requires explicit repair") }))
    }

    func testAuthRefreshSelectionGuardReturnsAccountChanged() {
        XCTAssertEqual(
            AuthManager.refreshResultWhenSelectionChanges(
                startedAccountId: "org-first",
                currentAccountId: "org-second"
            ),
            .accountChanged
        )
        XCTAssertNil(
            AuthManager.refreshResultWhenSelectionChanges(
                startedAccountId: "org-first",
                currentAccountId: "org-first"
            )
        )
    }

    private func legacyStoreValues() -> [String: String] {
        [
            MobileAccountStorageKey.encryptionKeySeed.rawValue: "legacy-seed",
            MobileAccountStorageKey.serverUrl.rawValue: "wss://sync.example.com",
            MobileAccountStorageKey.userId.rawValue: "legacy@example.com",
            MobileAccountStorageKey.authEmail.rawValue: "legacy@example.com",
            MobileAccountStorageKey.authOrgId.rawValue: "org-legacy",
            MobileAccountStorageKey.sessionToken.rawValue: "legacy-token",
            MobileAccountStorageKey.sessionJwt.rawValue: "legacy-jwt",
            MobileAccountStorageKey.authUserId.rawValue: "member-legacy",
            MobileAccountStorageKey.pairingPersonalOrgId.rawValue: "org-legacy",
            MobileAccountStorageKey.pairingPersonalUserId.rawValue: "member-legacy",
        ]
    }
}
