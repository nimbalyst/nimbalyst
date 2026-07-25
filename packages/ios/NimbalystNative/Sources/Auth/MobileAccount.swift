import Foundation

/// One independently paired personal account on this device.
///
/// The encryption seed and Stytch identity are intentionally stored together so
/// callers cannot accidentally derive a key from one account while routing sync
/// to another account's personal organization.
public struct MobileAccount: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var email: String
    public var personalOrgId: String
    public var sessionToken: String?
    public var sessionJwt: String?
    public var stytchUserId: String?
    public var authUserId: String?
    public var e2eSeed: String
    public var serverUrl: String
    public var expiresAt: String?
    public var analyticsId: String?
    public var usesLegacyDatabase: Bool

    public init(
        id: String,
        email: String,
        personalOrgId: String,
        sessionToken: String? = nil,
        sessionJwt: String? = nil,
        stytchUserId: String? = nil,
        authUserId: String? = nil,
        e2eSeed: String,
        serverUrl: String,
        expiresAt: String? = nil,
        analyticsId: String? = nil,
        usesLegacyDatabase: Bool = false
    ) {
        self.id = id
        self.email = email
        self.personalOrgId = personalOrgId
        self.sessionToken = sessionToken
        self.sessionJwt = sessionJwt
        self.stytchUserId = stytchUserId
        self.authUserId = authUserId
        self.e2eSeed = e2eSeed
        self.serverUrl = serverUrl
        self.expiresAt = expiresAt
        self.analyticsId = analyticsId
        self.usesLegacyDatabase = usesLegacyDatabase
    }

    private enum CodingKeys: String, CodingKey {
        case id, email, personalOrgId, sessionToken, sessionJwt, stytchUserId
        case authUserId, e2eSeed, serverUrl, expiresAt, analyticsId, usesLegacyDatabase
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        email = try container.decode(String.self, forKey: .email)
        personalOrgId = try container.decode(String.self, forKey: .personalOrgId)
        sessionToken = try container.decodeIfPresent(String.self, forKey: .sessionToken)
        sessionJwt = try container.decodeIfPresent(String.self, forKey: .sessionJwt)
        stytchUserId = try container.decodeIfPresent(String.self, forKey: .stytchUserId)
        authUserId = try container.decodeIfPresent(String.self, forKey: .authUserId)
        e2eSeed = try container.decode(String.self, forKey: .e2eSeed)
        serverUrl = try container.decode(String.self, forKey: .serverUrl)
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)
        analyticsId = try container.decodeIfPresent(String.self, forKey: .analyticsId)
        usesLegacyDatabase = try container.decodeIfPresent(Bool.self, forKey: .usesLegacyDatabase) ?? false
    }
}

/// Snapshot of the pre-multi-account Keychain fields used only during migration.
public struct LegacyMobileAccountRecord: Equatable, Sendable {
    public let email: String
    public let personalOrgId: String
    public let sessionToken: String?
    public let sessionJwt: String?
    public let stytchUserId: String?
    public let authUserId: String?
    public let e2eSeed: String
    public let serverUrl: String
    public let expiresAt: String?
    public let analyticsId: String?

    public init(
        email: String,
        personalOrgId: String,
        sessionToken: String? = nil,
        sessionJwt: String? = nil,
        stytchUserId: String? = nil,
        authUserId: String? = nil,
        e2eSeed: String,
        serverUrl: String,
        expiresAt: String? = nil,
        analyticsId: String? = nil
    ) {
        self.email = email
        self.personalOrgId = personalOrgId
        self.sessionToken = sessionToken
        self.sessionJwt = sessionJwt
        self.stytchUserId = stytchUserId
        self.authUserId = authUserId
        self.e2eSeed = e2eSeed
        self.serverUrl = serverUrl
        self.expiresAt = expiresAt
        self.analyticsId = analyticsId
    }
}

public struct MobileAccountRuntimeScope: Equatable, Sendable {
    public let accountId: String
    public let databaseScopeId: String
    public let personalOrgId: String
    public let sessionJwt: String?
    public let serverUrl: String
    public let e2eSeed: String
    public let stytchUserId: String?
    public let usesLegacyDatabase: Bool
}

public struct AccountSelectionChange: Equatable, Sendable {
    public let previousAccountId: String?
    public let selectedAccountId: String

    public var requiresRuntimeRebuild: Bool {
        previousAccountId != selectedAccountId
    }
}

public enum MobileAccountError: Error, LocalizedError, Equatable {
    case accountNotFound(String)
    case emailMismatch(expected: String)

    public var errorDescription: String? {
        switch self {
        case .accountNotFound:
            return "The selected account is no longer available."
        case .emailMismatch(let expected):
            return "Wrong account. Sign in with \(expected) to match this desktop pairing."
        }
    }
}

/// Pure, testable account-array state. KeychainManager is the persistence adapter.
public struct MobileAccountState: Equatable, Sendable {
    public var accounts: [MobileAccount]
    public var activeAccountId: String?

    public init(accounts: [MobileAccount], activeAccountId: String?) {
        self.accounts = accounts
        if let activeAccountId, accounts.contains(where: { $0.id == activeAccountId }) {
            self.activeAccountId = activeAccountId
        } else {
            self.activeAccountId = accounts.first?.id
        }
    }

    public static func migrating(
        accounts: [MobileAccount]?,
        activeAccountId: String?,
        legacy: LegacyMobileAccountRecord?
    ) -> MobileAccountState {
        if let accounts, !accounts.isEmpty {
            return MobileAccountState(accounts: accounts, activeAccountId: activeAccountId)
        }
        guard let legacy else {
            return MobileAccountState(accounts: [], activeAccountId: nil)
        }

        let normalizedEmail = legacy.email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let id = legacy.personalOrgId.isEmpty
            ? "legacy:\(normalizedEmail.isEmpty ? "account" : normalizedEmail)"
            : legacy.personalOrgId
        let account = MobileAccount(
            id: id,
            email: legacy.email,
            personalOrgId: legacy.personalOrgId,
            sessionToken: legacy.sessionToken,
            sessionJwt: legacy.sessionJwt,
            stytchUserId: legacy.stytchUserId,
            authUserId: legacy.authUserId,
            e2eSeed: legacy.e2eSeed,
            serverUrl: legacy.serverUrl,
            expiresAt: legacy.expiresAt,
            analyticsId: legacy.analyticsId,
            usesLegacyDatabase: true
        )
        return MobileAccountState(accounts: [account], activeAccountId: account.id)
    }

    public var activeAccount: MobileAccount? {
        guard let activeAccountId else { return nil }
        return accounts.first(where: { $0.id == activeAccountId })
    }

    public var runtimeScope: MobileAccountRuntimeScope? {
        guard let account = activeAccount else { return nil }
        return MobileAccountRuntimeScope(
            accountId: account.id,
            databaseScopeId: account.id,
            personalOrgId: account.personalOrgId,
            sessionJwt: account.sessionJwt,
            serverUrl: account.serverUrl,
            e2eSeed: account.e2eSeed,
            stytchUserId: account.stytchUserId ?? account.authUserId,
            usesLegacyDatabase: account.usesLegacyDatabase
        )
    }

    @discardableResult
    public mutating func selectAccount(_ id: String) throws -> AccountSelectionChange {
        guard accounts.contains(where: { $0.id == id }) else {
            throw MobileAccountError.accountNotFound(id)
        }
        let change = AccountSelectionChange(previousAccountId: activeAccountId, selectedAccountId: id)
        activeAccountId = id
        return change
    }

    @discardableResult
    public mutating func addOrUpdatePairing(
        email: String,
        personalOrgId: String,
        stytchUserId: String?,
        e2eSeed: String,
        serverUrl: String,
        analyticsId: String? = nil
    ) throws -> MobileAccount {
        let normalizedEmail = Self.normalizedEmail(email)
        let matchIndex = accounts.firstIndex { account in
            if !personalOrgId.isEmpty && account.personalOrgId == personalOrgId {
                return true
            }
            return account.personalOrgId.isEmpty && Self.normalizedEmail(account.email) == normalizedEmail
        }

        if let matchIndex {
            var account = accounts[matchIndex]
            let sameEmail = Self.normalizedEmail(account.email) == normalizedEmail
            account.email = email
            account.personalOrgId = personalOrgId
            account.stytchUserId = stytchUserId ?? account.stytchUserId
            account.e2eSeed = e2eSeed
            account.serverUrl = serverUrl
            account.analyticsId = analyticsId ?? account.analyticsId
            if !sameEmail {
                account.sessionToken = nil
                account.sessionJwt = nil
                account.authUserId = nil
                account.expiresAt = nil
            }
            accounts[matchIndex] = account
            activeAccountId = account.id
            return account
        }

        let id = personalOrgId.isEmpty ? UUID().uuidString : personalOrgId
        let account = MobileAccount(
            id: id,
            email: email,
            personalOrgId: personalOrgId,
            stytchUserId: stytchUserId,
            e2eSeed: e2eSeed,
            serverUrl: serverUrl,
            analyticsId: analyticsId
        )
        accounts.append(account)
        activeAccountId = account.id
        return account
    }

    public func validateAuthenticatedEmail(_ email: String) throws {
        guard let expected = activeAccount?.email,
              expected.contains("@"),
              !email.isEmpty,
              Self.normalizedEmail(expected) != Self.normalizedEmail(email) else {
            return
        }
        throw MobileAccountError.emailMismatch(expected: expected)
    }

    private static func normalizedEmail(_ email: String) -> String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}
