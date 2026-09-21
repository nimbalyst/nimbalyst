import Foundation

enum SyncCredentials {
    /// Re-read the token after refresh, and fence both account changes and
    /// cancellation before letting a caller open a socket with the result.
    @MainActor
    static func freshToken(
        read: () -> String?,
        isCurrent: () -> Bool,
        refresh: () async -> Bool
    ) async -> String? {
        guard !Task.isCancelled, isCurrent(), let token = read() else { return nil }
        if isExpiringSoon(token) {
            guard await refresh() else { return nil }
        }
        guard !Task.isCancelled, isCurrent(), let fresh = read(), !isExpiringSoon(fresh) else { return nil }
        return fresh
    }

    /// Check if a JWT's exp claim is within `margin` seconds of now.
    static func isExpiringSoon(_ jwt: String, margin: TimeInterval = 60) -> Bool {
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
    static func orgId(from jwt: String) -> String? {
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

}
