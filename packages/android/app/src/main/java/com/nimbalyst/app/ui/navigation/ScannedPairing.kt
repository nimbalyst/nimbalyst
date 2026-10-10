package com.nimbalyst.app.ui.navigation

import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.pairing.QRPairingData

/**
 * Credentials to save after the in-app camera scans a pairing QR. The sign-in is kept
 * only when the code is for the same account; a different account must sign in again.
 * [com.nimbalyst.app.pairing.PairingStore.savePairing] separately drops the sign-in
 * when the server changes.
 */
internal fun credentialsForScannedPairing(
    existing: PairingCredentials?,
    scanned: QRPairingData,
): PairingCredentials {
    val fresh = PairingCredentials(
        serverUrl = scanned.serverUrl,
        encryptionSeed = scanned.seed,
        pairedUserId = scanned.userId,
        personalOrgId = scanned.personalOrgId,
        personalUserId = scanned.personalUserId,
    )
    if (existing == null || existing.pairedUserId != scanned.userId) return fresh
    return existing.copy(
        serverUrl = fresh.serverUrl,
        encryptionSeed = fresh.encryptionSeed,
        personalOrgId = fresh.personalOrgId,
        personalUserId = fresh.personalUserId,
    )
}
