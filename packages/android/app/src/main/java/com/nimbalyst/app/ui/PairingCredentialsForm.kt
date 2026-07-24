package com.nimbalyst.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

data class PairingFormState(
    val serverUrl: String = "",
    val encryptionSeed: String = "",
    val pairedUserId: String = "",
    val authOrgId: String = "",
    val authUserId: String = "",
    val orgId: String = "",
    val personalUserId: String = "",
    val authJwt: String = "",
)

@Composable
fun PairingCredentialsForm(
    state: PairingFormState,
    onStateChange: (PairingFormState) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    saveLabel: String = "Save pairing",
    message: String? = null,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        OutlinedTextField(
            value = state.serverUrl,
            onValueChange = { onStateChange(state.copy(serverUrl = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Server URL") },
            singleLine = true
        )
        OutlinedTextField(
            value = state.encryptionSeed,
            onValueChange = { onStateChange(state.copy(encryptionSeed = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Encryption seed") },
            minLines = 2
        )
        OutlinedTextField(
            value = state.pairedUserId,
            onValueChange = { onStateChange(state.copy(pairedUserId = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Paired account email or user ID") },
            singleLine = true
        )
        OutlinedTextField(
            value = state.authOrgId,
            onValueChange = { onStateChange(state.copy(authOrgId = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Auth org ID") },
            singleLine = true
        )
        OutlinedTextField(
            value = state.authUserId,
            onValueChange = { onStateChange(state.copy(authUserId = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Auth user ID") },
            singleLine = true
        )
        OutlinedTextField(
            value = state.orgId,
            onValueChange = { onStateChange(state.copy(orgId = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Personal org ID override") },
            singleLine = true
        )
        OutlinedTextField(
            value = state.personalUserId,
            onValueChange = { onStateChange(state.copy(personalUserId = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Personal user ID override") },
            singleLine = true
        )
        OutlinedTextField(
            value = state.authJwt,
            onValueChange = { onStateChange(state.copy(authJwt = it)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Session JWT") },
            minLines = 3
        )
        message?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Button(
            onClick = onSave,
            enabled = state.serverUrl.isNotBlank() && state.encryptionSeed.isNotBlank()
        ) {
            Text(saveLabel)
        }
    }
}
