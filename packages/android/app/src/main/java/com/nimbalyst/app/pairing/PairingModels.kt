package com.nimbalyst.app.pairing

data class PairingCredentials(
    val serverUrl: String,
    val encryptionSeed: String,
    val pairedUserId: String? = null,
    val authJwt: String? = null,
    val authUserId: String? = null,
    val orgId: String? = null,
    val personalUserId: String? = null,
    val personalOrgId: String? = null,
    val sessionToken: String? = null,
    val authEmail: String? = null,
    val authExpiresAt: String? = null,
) {
    val routingUserId: String?
        get() = personalUserId ?: authUserId ?: pairedUserId

    val cryptoUserId: String?
        get() = authUserId

    val routingOrgId: String?
        get() = personalOrgId ?: orgId

    val hasAuthToken: Boolean
        get() = !authJwt.isNullOrBlank()

    internal fun sanitizedForServerChange(existing: PairingCredentials?): PairingCredentials {
        if (existing == null || existing.serverUrl == serverUrl) {
            return this
        }

        return copy(
            authJwt = null,
            authUserId = null,
            orgId = null,
            sessionToken = null,
            authEmail = null,
            authExpiresAt = null,
        )
    }
}

data class PairingState(
    val credentials: PairingCredentials? = null,
) {
    val isPaired: Boolean
        get() = credentials != null

    val isAuthenticated: Boolean
        get() = credentials?.hasAuthToken == true && credentials?.authUserId != null

    val isSyncConfigured: Boolean
        get() = credentials?.hasAuthToken == true
}
