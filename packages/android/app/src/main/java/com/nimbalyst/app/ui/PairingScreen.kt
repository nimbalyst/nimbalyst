package com.nimbalyst.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.pairing.QRPairingData
import com.nimbalyst.app.ui.components.NimbalystPrimaryButton
import com.nimbalyst.app.ui.theme.NimbalystColors

@Composable
fun PairingScreen(
    onPaired: (PairingCredentials) -> Unit
) {
    var showQrScanner by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    val invalidQrMessage = stringResource(R.string.pairing_invalid_qr)

    if (showQrScanner) {
        PairingQrScanner(
            onScanned = { rawValue ->
                val parsed = QRPairingData.parse(rawValue)
                if (parsed == null) {
                    errorMessage = invalidQrMessage
                    showQrScanner = false
                } else {
                    AnalyticsManager.setDistinctIdFromPairing(parsed.analyticsId)
                    AnalyticsManager.capture("mobile_pairing_completed")
                    onPaired(
                        PairingCredentials(
                            serverUrl = parsed.serverUrl,
                            encryptionSeed = parsed.seed,
                            pairedUserId = parsed.userId,
                            personalOrgId = parsed.personalOrgId,
                            personalUserId = parsed.personalUserId
                        )
                    )
                }
            },
            onCancel = { showQrScanner = false }
        )
        return
    }

    // Layout mirrors iOS PairingView: icon, title, instructions, error, then the scan button.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            imageVector = Icons.Default.QrCodeScanner,
            contentDescription = null,
            modifier = Modifier.size(72.dp),
            tint = NimbalystColors.primary
        )

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = stringResource(R.string.pairing_title),
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = stringResource(R.string.pairing_instructions),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )

        errorMessage?.let { error ->
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = error,
                style = MaterialTheme.typography.bodyMedium,
                color = NimbalystColors.error,
                textAlign = TextAlign.Center
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        NimbalystPrimaryButton(
            text = stringResource(R.string.pairing_scan_button),
            onClick = {
                errorMessage = null
                showQrScanner = true
            },
            modifier = Modifier.fillMaxWidth(),
            leading = {
                Icon(Icons.Default.PhotoCamera, contentDescription = null, modifier = Modifier.size(20.dp))
            }
        )
    }
}
