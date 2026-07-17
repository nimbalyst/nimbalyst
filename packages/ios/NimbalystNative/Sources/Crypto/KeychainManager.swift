import Foundation
import Security
import os

enum MobileAccountStorageKey: String {
    case mobileAccounts = "mobile_accounts_v2"
    case activeAccountId = "active_mobile_account_id"
    case corruptAccountsBackup = "mobile_accounts_v2_corrupt_backup"
    case encryptionKeySeed = "encryption_key_seed"
    case serverUrl = "server_url"
    case userId = "user_id"
    case sessionToken = "stytch_session_token"
    case sessionJwt = "stytch_session_jwt"
    case authUserId = "stytch_user_id"
    case authEmail = "stytch_email"
    case authExpiresAt = "stytch_expires_at"
    case authOrgId = "stytch_org_id"
    case openAIApiKey = "openai_api_key"
    case analyticsId = "analytics_id"
    case pairingPersonalOrgId = "pairing_personal_org_id"
    case pairingPersonalUserId = "pairing_personal_user_id"
}

protocol MobileAccountSecureStore: AnyObject {
    func readValue(forKey key: String) -> String?
    func writeValue(_ value: String, forKey key: String) throws
    func deleteValue(forKey key: String)
}

enum MobileAccountStorageIssue: Equatable {
    case recoveredCorruptBlob
    case corruptBlobUnrecoverable
}

struct MobileAccountLoadResult {
    let state: MobileAccountState
    let issue: MobileAccountStorageIssue?
    let didMigrateLegacy: Bool

    var requiresExplicitRepair: Bool {
        issue == .corruptBlobUnrecoverable
    }
}

/// Converts the original single-account Keychain keys into the account array.
/// This logic is kept separate from Security.framework so migration and corrupt
/// data recovery can be verified without mutating a device Keychain.
final class MobileAccountKeychainAdapter {
    private let store: MobileAccountSecureStore
    private let log: (String) -> Void

    init(store: MobileAccountSecureStore, log: @escaping (String) -> Void = { _ in }) {
        self.store = store
        self.log = log
    }

    func loadAccountState() -> MobileAccountLoadResult {
        let encodedAccounts = read(.mobileAccounts)
        let activeAccountId = read(.activeAccountId)

        if let encodedAccounts {
            do {
                let accounts = try JSONDecoder().decode(
                    [MobileAccount].self,
                    from: Data(encodedAccounts.utf8)
                )
                return MobileAccountLoadResult(
                    state: MobileAccountState.migrating(
                        accounts: accounts,
                        activeAccountId: activeAccountId,
                        legacy: nil
                    ),
                    issue: nil,
                    didMigrateLegacy: false
                )
            } catch {
                log("mobile_accounts_v2 failed to decode: \(error.localizedDescription); attempting legacy account recovery")
            }
            guard let legacy = legacyRecord() else {
                log("mobile_accounts_v2 is unreadable and no legacy account exists; account storage requires explicit repair")
                return MobileAccountLoadResult(
                    state: MobileAccountState(accounts: [], activeAccountId: nil),
                    issue: .corruptBlobUnrecoverable,
                    didMigrateLegacy: false
                )
            }

            let recoveredState = MobileAccountState.migrating(
                accounts: nil,
                activeAccountId: activeAccountId,
                legacy: legacy
            )
            do {
                // Preserve the exact unreadable value before replacing the primary
                // entry. If a prior backup exists, leave both values untouched and
                // require explicit repair rather than discarding either one.
                guard read(.corruptAccountsBackup) == nil else {
                    log("mobile_accounts_v2 recovery found an existing corrupt backup and requires explicit repair")
                    return MobileAccountLoadResult(
                        state: MobileAccountState(accounts: [], activeAccountId: nil),
                        issue: .corruptBlobUnrecoverable,
                        didMigrateLegacy: false
                    )
                }
                try write(encodedAccounts, .corruptAccountsBackup)
                try storeAccountState(recoveredState)
                log("mobile_accounts_v2 recovered from legacy account data; corrupt source was preserved")
                return MobileAccountLoadResult(
                    state: recoveredState,
                    issue: .recoveredCorruptBlob,
                    didMigrateLegacy: false
                )
            } catch {
                log("mobile_accounts_v2 recovery could not be persisted and requires explicit repair: \(error.localizedDescription)")
                return MobileAccountLoadResult(
                    state: MobileAccountState(accounts: [], activeAccountId: nil),
                    issue: .corruptBlobUnrecoverable,
                    didMigrateLegacy: false
                )
            }
        }

        guard let legacy = legacyRecord() else {
            return MobileAccountLoadResult(
                state: MobileAccountState(accounts: [], activeAccountId: nil),
                issue: nil,
                didMigrateLegacy: false
            )
        }

        let migratedState = MobileAccountState.migrating(
            accounts: nil,
            activeAccountId: activeAccountId,
            legacy: legacy
        )
        do {
            try storeAccountState(migratedState)
            return MobileAccountLoadResult(
                state: migratedState,
                issue: nil,
                didMigrateLegacy: true
            )
        } catch {
            log("Legacy mobile account migration failed to persist: \(error.localizedDescription)")
            return MobileAccountLoadResult(
                state: migratedState,
                issue: nil,
                didMigrateLegacy: false
            )
        }
    }

    func storeAccountState(_ state: MobileAccountState) throws {
        let data = try JSONEncoder().encode(state.accounts)
        guard let json = String(data: data, encoding: .utf8) else {
            throw KeychainManager.KeychainError.invalidAccountData
        }
        if let activeAccountId = state.activeAccountId {
            try write(activeAccountId, .activeAccountId)
        } else {
            store.deleteValue(forKey: MobileAccountStorageKey.activeAccountId.rawValue)
        }
        // Write the account array last so corrupt-blob recovery never replaces
        // the only source value unless all supporting writes have succeeded.
        try write(json, .mobileAccounts)
    }

    private func legacyRecord() -> LegacyMobileAccountRecord? {
        guard let seed = read(.encryptionKeySeed) else { return nil }
        return LegacyMobileAccountRecord(
            email: read(.authEmail) ?? read(.userId) ?? "",
            personalOrgId: read(.pairingPersonalOrgId) ?? read(.authOrgId) ?? "",
            sessionToken: read(.sessionToken),
            sessionJwt: read(.sessionJwt),
            stytchUserId: read(.pairingPersonalUserId) ?? read(.authUserId),
            authUserId: read(.authUserId),
            e2eSeed: seed,
            serverUrl: read(.serverUrl) ?? "",
            expiresAt: read(.authExpiresAt),
            analyticsId: read(.analyticsId)
        )
    }

    private func read(_ key: MobileAccountStorageKey) -> String? {
        store.readValue(forKey: key.rawValue)
    }

    private func write(_ value: String, _ key: MobileAccountStorageKey) throws {
        try store.writeValue(value, forKey: key.rawValue)
    }
}

private final class SystemKeychainStore: MobileAccountSecureStore {
    private let service: String

    init(service: String) {
        self.service = service
    }

    func writeValue(_ value: String, forKey key: String) throws {
        deleteValue(forKey: key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainManager.KeychainError.storeFailed(status)
        }
    }

    func readValue(forKey key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func deleteValue(forKey key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// Manages iOS Keychain storage for encryption keys and sensitive configuration.
/// The encryption key seed is stored in the Keychain (not SQLite) for security.
enum KeychainManager {
    private static let service = "com.nimbalyst.app"
    private typealias Key = MobileAccountStorageKey
    nonisolated(unsafe) private static let secureStore = SystemKeychainStore(service: service)
    nonisolated(unsafe) private static let accountAdapter = MobileAccountKeychainAdapter(store: secureStore) { message in
        Logger(subsystem: service, category: "KeychainManager").fault("\(message, privacy: .public)")
    }

    // MARK: - Mobile Accounts

    static func getAccountState() -> MobileAccountState {
        getAccountLoadResult().state
    }

    static func getAccountLoadResult() -> MobileAccountLoadResult {
        accountAdapter.loadAccountState()
    }

    static func getAccounts() -> [MobileAccount] {
        getAccountState().accounts
    }

    static func getActiveAccount() -> MobileAccount? {
        getAccountState().activeAccount
    }

    static func setActiveAccount(id: String) throws -> AccountSelectionChange {
        var state = getAccountState()
        let change = try state.selectAccount(id)
        try storeAccountState(state)
        return change
    }

    @discardableResult
    static func upsertPairingAccount(
        email: String,
        personalOrgId: String,
        stytchUserId: String?,
        e2eSeed: String,
        serverUrl: String,
        analyticsId: String?
    ) throws -> MobileAccount {
        var state = getAccountState()
        let account = try state.addOrUpdatePairing(
            email: email,
            personalOrgId: personalOrgId,
            stytchUserId: stytchUserId,
            e2eSeed: e2eSeed,
            serverUrl: serverUrl,
            analyticsId: analyticsId
        )
        try storeAccountState(state)
        return account
    }

    static func validateAuthenticatedEmail(_ email: String) throws {
        try getAccountState().validateAuthenticatedEmail(email)
    }

    private static func updateActiveAccount(_ update: (inout MobileAccount) -> Void) throws {
        var state = getAccountState()
        guard let activeAccountId = state.activeAccountId,
              let index = state.accounts.firstIndex(where: { $0.id == activeAccountId }) else {
            throw MobileAccountError.accountNotFound(state.activeAccountId ?? "")
        }
        update(&state.accounts[index])
        try storeAccountState(state)
    }

    private static func storeAccountState(_ state: MobileAccountState) throws {
        try accountAdapter.storeAccountState(state)
    }

    // MARK: - Encryption Key

    static func storeEncryptionKey(seed: String) throws {
        if getActiveAccount() != nil {
            try updateActiveAccount { $0.e2eSeed = seed }
        } else {
            try store(key: .encryptionKeySeed, value: seed)
        }
    }

    static func getEncryptionKey() -> String? {
        getActiveAccount()?.e2eSeed
    }

    static func hasEncryptionKey() -> Bool {
        getEncryptionKey() != nil
    }

    // MARK: - Server URL

    static func storeServerUrl(_ url: String) throws {
        if getActiveAccount() != nil {
            try updateActiveAccount { $0.serverUrl = url }
        } else {
            try store(key: .serverUrl, value: url)
        }
    }

    static func getServerUrl() -> String? {
        getActiveAccount()?.serverUrl
    }

    // MARK: - User ID

    static func storeUserId(_ userId: String) throws {
        if getActiveAccount() != nil {
            try updateActiveAccount { $0.email = userId }
        } else {
            try store(key: .userId, value: userId)
        }
    }

    static func getUserId() -> String? {
        getActiveAccount()?.email
    }

    // MARK: - Auth Session (Stytch)

    /// Store a complete auth session from the OAuth callback.
    static func storeAuthSession(
        sessionToken: String,
        sessionJwt: String,
        userId: String,
        email: String,
        expiresAt: String,
        orgId: String
    ) throws {
        try updateActiveAccount { account in
            account.sessionToken = sessionToken
            account.sessionJwt = sessionJwt
            account.authUserId = userId
            if account.stytchUserId == nil || account.stytchUserId?.isEmpty == true {
                account.stytchUserId = userId
            }
            account.email = email
            account.expiresAt = expiresAt
            if account.personalOrgId.isEmpty {
                account.personalOrgId = orgId
            }
        }
    }

    static func getSessionJwt() -> String? {
        getActiveAccount()?.sessionJwt
    }

    static func getSessionToken() -> String? {
        getActiveAccount()?.sessionToken
    }

    static func getAuthUserId() -> String? {
        guard let account = getActiveAccount() else { return nil }
        return account.authUserId ?? account.stytchUserId
    }

    static func getAuthEmail() -> String? {
        getActiveAccount()?.email
    }

    static func getAuthOrgId() -> String? {
        getActiveAccount()?.personalOrgId
    }

    static func hasAuthSession() -> Bool {
        getSessionJwt() != nil
    }

    static func deleteAuthSession() {
        try? updateActiveAccount { account in
            account.sessionToken = nil
            account.sessionJwt = nil
            account.authUserId = nil
            account.expiresAt = nil
        }
    }

    // MARK: - OpenAI API Key

    static func storeOpenAIApiKey(_ key: String) throws {
        try store(key: .openAIApiKey, value: key)
    }

    static func getOpenAIApiKey() -> String? {
        retrieve(key: .openAIApiKey)
    }

    static func deleteOpenAIApiKey() {
        delete(key: .openAIApiKey)
    }

    // MARK: - Analytics ID

    static func storeAnalyticsId(_ id: String) throws {
        try store(key: .analyticsId, value: id)
    }

    static func getAnalyticsId() -> String? {
        retrieve(key: .analyticsId)
    }

    static func deleteAnalyticsId() {
        delete(key: .analyticsId)
    }

    // MARK: - Pairing Personal Org/User (for room routing)

    static func storePairingPersonalOrgId(_ orgId: String) throws {
        if getActiveAccount() != nil {
            try updateActiveAccount { $0.personalOrgId = orgId }
        } else {
            try store(key: .pairingPersonalOrgId, value: orgId)
        }
    }

    static func getPairingPersonalOrgId() -> String? {
        getActiveAccount()?.personalOrgId
    }

    static func storePairingPersonalUserId(_ userId: String) throws {
        if getActiveAccount() != nil {
            try updateActiveAccount { $0.stytchUserId = userId }
        } else {
            try store(key: .pairingPersonalUserId, value: userId)
        }
    }

    static func getPairingPersonalUserId() -> String? {
        getActiveAccount()?.stytchUserId
    }

    // MARK: - Cleanup

    static func deleteAll() {
        delete(key: .mobileAccounts)
        delete(key: .activeAccountId)
        delete(key: .corruptAccountsBackup)
        delete(key: .encryptionKeySeed)
        delete(key: .serverUrl)
        delete(key: .userId)
        deleteAuthSession()
        deleteOpenAIApiKey()
        deleteAnalyticsId()
        delete(key: .pairingPersonalOrgId)
        delete(key: .pairingPersonalUserId)
    }

    // MARK: - Generic Keychain Operations

    private static func store(key: Key, value: String) throws {
        try secureStore.writeValue(value, forKey: key.rawValue)
    }

    private static func retrieve(key: Key) -> String? {
        secureStore.readValue(forKey: key.rawValue)
    }

    private static func delete(key: Key) {
        secureStore.deleteValue(forKey: key.rawValue)
    }

    enum KeychainError: Error, LocalizedError {
        case storeFailed(OSStatus)
        case invalidAccountData

        var errorDescription: String? {
            switch self {
            case .storeFailed(let status):
                return "Keychain store failed with status: \(status)"
            case .invalidAccountData:
                return "Keychain account data could not be encoded"
            }
        }
    }
}
