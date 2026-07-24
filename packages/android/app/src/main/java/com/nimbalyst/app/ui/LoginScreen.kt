package com.nimbalyst.app.ui

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.auth.MagicLinkClient
import com.nimbalyst.app.auth.hasEmailAccount
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(
    serverUrl: String,
    pairedEmail: String?,
    onUnpair: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var magicLinkSent by rememberSaveable { mutableStateOf(false) }
    var isSending by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val hasEmailAccount = hasEmailAccount(pairedEmail)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            imageVector = Icons.Default.AccountCircle,
            contentDescription = null,
            modifier = Modifier.size(80.dp),
            tint = MaterialTheme.colorScheme.primary
        )

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "Sign In",
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(12.dp))

        if (!pairedEmail.isNullOrBlank()) {
            Text(
                text = buildAnnotatedString {
                    append("Sign in as ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
                        append(pairedEmail)
                    }
                    append(" to sync with your Mac.")
                },
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
        } else {
            Text(
                text = "Sign in to sync sessions with your Mac.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        if (magicLinkSent) {
            // "Check your email" state — mirrors iOS magicLinkSentView
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Email,
                    contentDescription = null,
                    modifier = Modifier.size(48.dp),
                    tint = MaterialTheme.colorScheme.primary
                )

                Text(
                    text = "Check your email",
                    style = MaterialTheme.typography.titleMedium
                )

                Text(
                    text = "We sent a sign-in link to $pairedEmail. Tap the link in your email to continue.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )

                TextButton(
                    onClick = {
                        if (!isSending && hasEmailAccount) {
                            isSending = true
                            errorMessage = null
                            magicLinkSent = false
                            scope.launch {
                                val result = MagicLinkClient.sendMagicLink(serverUrl, pairedEmail!!)
                                result.fold(
                                    onSuccess = { magicLinkSent = true },
                                    onFailure = { errorMessage = it.message ?: "Network error. Please try again." }
                                )
                                isSending = false
                            }
                        }
                    },
                    enabled = !isSending
                ) {
                    Text("Resend link")
                }

                TextButton(
                    onClick = { magicLinkSent = false }
                ) {
                    Text(
                        text = "Use a different sign-in method",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else {
            // Sign-in buttons state
            Button(
                onClick = {
                    val loginUrl = serverUrl
                        .replace("wss://", "https://")
                        .replace("ws://", "http://")
                        .trimEnd('/') + "/auth/login/google"
                    AnalyticsManager.capture("mobile_login_started", mapOf("method" to "google"))
                    CustomTabsIntent.Builder()
                        .build()
                        .launchUrl(context, Uri.parse(loginUrl))
                },
                enabled = !isSending,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Sign in with Google")
            }

            if (hasEmailAccount) {
                Spacer(modifier = Modifier.height(12.dp))

                OutlinedButton(
                    onClick = {
                        if (!isSending) {
                            isSending = true
                            errorMessage = null
                            AnalyticsManager.capture("mobile_login_started", mapOf("method" to "magic_link"))
                            scope.launch {
                                val result = MagicLinkClient.sendMagicLink(serverUrl, pairedEmail!!)
                                result.fold(
                                    onSuccess = { magicLinkSent = true },
                                    onFailure = { errorMessage = it.message ?: "Network error. Please try again." }
                                )
                                isSending = false
                            }
                        }
                    },
                    enabled = !isSending,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    if (isSending) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Sending...")
                    } else {
                        Text("Sign in with email link")
                    }
                }
            }
        }

        // Error row (non-null when a request failed)
        if (errorMessage != null) {
            Spacer(modifier = Modifier.height(16.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Icon(
                    imageVector = Icons.Default.Warning,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(16.dp)
                )
                Text(
                    text = errorMessage!!,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }

        Spacer(modifier = Modifier.height(48.dp))

        TextButton(onClick = {
            AnalyticsManager.capture("mobile_device_unpairing")
            AnalyticsManager.reset()
            onUnpair()
        }) {
            Text(
                text = "Unpair Device",
                color = MaterialTheme.colorScheme.error
            )
        }
    }
}
