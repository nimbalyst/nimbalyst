package com.nimbalyst.app.ui

import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.HowToReg
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.auth.MagicLinkClient
import com.nimbalyst.app.auth.hasEmailAccount
import com.nimbalyst.app.ui.components.NimbalystPrimaryButton
import com.nimbalyst.app.ui.components.NimbalystSecondaryButton
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.ui.theme.NimbalystShapes
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(
    serverUrl: String,
    pairedEmail: String?,
    onUnpair: () -> Unit,
    /** Why the last auth callback failed (e.g. the server's error_description), or null. */
    callbackFailure: String? = null,
    onDismissCallbackFailure: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var magicLinkSent by rememberSaveable { mutableStateOf(false) }
    var isSending by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val hasEmailAccount = hasEmailAccount(pairedEmail)
    val networkError = stringResource(R.string.login_network_error)

    fun sendMagicLink() {
        if (isSending || !hasEmailAccount) return
        isSending = true
        errorMessage = null
        onDismissCallbackFailure()
        scope.launch {
            MagicLinkClient.sendMagicLink(serverUrl, pairedEmail!!).fold(
                onSuccess = { magicLinkSent = true },
                onFailure = { errorMessage = it.message ?: networkError }
            )
            isSending = false
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 32.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterVertically)
    ) {
        Icon(
            imageVector = Icons.Default.HowToReg,
            contentDescription = null,
            modifier = Modifier.size(64.dp),
            tint = NimbalystColors.primary
        )

        Text(
            text = stringResource(R.string.login_title),
            style = MaterialTheme.typography.headlineMedium,
            textAlign = TextAlign.Center
        )

        Text(
            text = if (!pairedEmail.isNullOrBlank()) {
                boldSubstring(stringResource(R.string.login_subtitle_paired, pairedEmail), pairedEmail)
            } else {
                AnnotatedString(stringResource(R.string.login_subtitle))
            },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )

        if (magicLinkSent) {
            // "Check your email" state -- mirrors iOS magicLinkSentView
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Icon(
                    imageVector = Icons.Default.Email,
                    contentDescription = null,
                    modifier = Modifier.size(48.dp),
                    tint = NimbalystColors.primary
                )
                Text(
                    text = stringResource(R.string.login_check_email),
                    style = MaterialTheme.typography.titleMedium
                )
                Text(
                    text = stringResource(R.string.login_magic_link_sent, pairedEmail.orEmpty()),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )
                TextButton(
                    onClick = {
                        magicLinkSent = false
                        sendMagicLink()
                    },
                    enabled = !isSending
                ) {
                    Text(stringResource(R.string.login_resend_link), color = NimbalystColors.primary)
                }
                TextButton(onClick = { magicLinkSent = false }) {
                    Text(
                        text = stringResource(R.string.login_use_different_method),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                NimbalystPrimaryButton(
                    text = stringResource(R.string.login_google),
                    onClick = {
                        onDismissCallbackFailure()
                        errorMessage = null
                        val loginUrl = serverUrl
                            .replace("wss://", "https://")
                            .replace("ws://", "http://")
                            .trimEnd('/') + "/auth/login/google"
                        AnalyticsManager.capture("mobile_login_started", mapOf("method" to "google"))
                        try {
                            CustomTabsIntent.Builder()
                                .build()
                                .launchUrl(context, Uri.parse(loginUrl))
                        } catch (_: ActivityNotFoundException) {
                            // Custom Tabs falls back to any browser; this fires only when there is none.
                            errorMessage = context.getString(R.string.login_no_browser)
                        }
                    },
                    enabled = !isSending
                )

                if (hasEmailAccount) {
                    NimbalystSecondaryButton(
                        text = stringResource(if (isSending) R.string.login_sending else R.string.login_email_link),
                        onClick = {
                            AnalyticsManager.capture("mobile_login_started", mapOf("method" to "magic_link"))
                            sendMagicLink()
                        },
                        enabled = !isSending,
                        loading = isSending
                    )
                }
            }
        }

        (errorMessage ?: callbackFailure)?.let { message ->
            AuthErrorBanner(
                message = message,
                onDismiss = {
                    errorMessage = null
                    onDismissCallbackFailure()
                }
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        TextButton(onClick = {
            AnalyticsManager.capture("mobile_device_unpairing")
            AnalyticsManager.reset()
            onUnpair()
        }) {
            Text(
                text = stringResource(R.string.login_unpair),
                color = MaterialTheme.colorScheme.error
            )
        }
    }
}

/** Warning-tinted banner matching the iOS LoginView auth error row. */
@Composable
private fun AuthErrorBanner(message: String, onDismiss: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .background(NimbalystColors.warning.copy(alpha = 0.1f), NimbalystShapes.banner)
            .padding(start = 12.dp, top = 4.dp, bottom = 4.dp)
    ) {
        Icon(
            imageVector = Icons.Default.Warning,
            contentDescription = null,
            tint = NimbalystColors.warning,
            modifier = Modifier.size(18.dp)
        )
        Text(
            text = message,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f).padding(vertical = 8.dp)
        )
        IconButton(onClick = onDismiss) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = stringResource(R.string.login_dismiss_error),
                tint = NimbalystColors.textFaint,
                modifier = Modifier.size(16.dp)
            )
        }
    }
}

private fun boldSubstring(text: String, bold: String): AnnotatedString = buildAnnotatedString {
    append(text)
    val start = text.indexOf(bold)
    if (start >= 0) {
        addStyle(SpanStyle(fontWeight = FontWeight.SemiBold), start, start + bold.length)
    }
}
