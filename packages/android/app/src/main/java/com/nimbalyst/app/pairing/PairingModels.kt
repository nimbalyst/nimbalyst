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

    // Encryption key salt must use the personal-org member ID (personalUserId),
    // matching desktop (`nimbalyst:${personalUserId}`) and iOS (`personalUserId ?? authUserId`).
    // After a team session exchange the JWT sub / authUserId becomes the team member ID,
    // which derives a different key and silently breaks decryption of all newer data.
    val cryptoUserId: String?
        get() = personalUserId ?: authUserId

    val routingOrgId: String?
        get() = personalOrgId ?: orgId

    val hasAuthToken: Boolean
        get() = !authJwt.isNullOrBlank()
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
