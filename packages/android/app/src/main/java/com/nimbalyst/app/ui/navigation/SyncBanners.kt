package com.nimbalyst.app.ui.navigation

import androidx.annotation.StringRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nimbalyst.app.R
import com.nimbalyst.app.documents.DocumentSaveFailure
import com.nimbalyst.app.documents.Documents
import com.nimbalyst.app.documents.SaveFailureBanner
import com.nimbalyst.app.sync.SyncError
import com.nimbalyst.app.sync.SyncErrorKind
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.delay

/** Mirrors iOS `SyncErrorPresentation`: caution = the change may still have landed. */
enum class SyncErrorSeverity { CAUTION, FAILURE }

internal fun syncErrorSeverity(kind: SyncErrorKind): SyncErrorSeverity = when (kind) {
    SyncErrorKind.TRANSPORT, SyncErrorKind.REQUEST_TIMEOUT -> SyncErrorSeverity.CAUTION
    SyncErrorKind.DECRYPT, SyncErrorKind.STORAGE, SyncErrorKind.PRESENCE -> SyncErrorSeverity.FAILURE
}

@StringRes
internal fun syncErrorTitle(kind: SyncErrorKind): Int = when (kind) {
    SyncErrorKind.TRANSPORT -> R.string.sync_error_transport
    SyncErrorKind.DECRYPT -> R.string.sync_error_decrypt
    SyncErrorKind.STORAGE -> R.string.sync_error_storage
    SyncErrorKind.PRESENCE -> R.string.sync_error_presence
    SyncErrorKind.REQUEST_TIMEOUT -> R.string.sync_error_request_timeout
}

/**
 * The single sync error slot, updated in place. The action clears first and then
 * retries, so a retry that fails at once can post a fresh error without it being wiped.
 */
@Composable
fun SyncErrorBanner(error: SyncError, onDismiss: () -> Unit) {
    val failure = syncErrorSeverity(error.kind) == SyncErrorSeverity.FAILURE
    val color = if (failure) NimbalystColors.error else NimbalystColors.warning
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.18f))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Icon(
            imageVector = if (failure) Icons.Default.ErrorOutline else Icons.Default.WarningAmber,
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(18.dp)
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(syncErrorTitle(error.kind)),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = error.message,
                style = MaterialTheme.typography.bodySmall,
                color = NimbalystColors.textMuted
            )
        }
        OutlinedButton(
            onClick = {
                onDismiss()
                error.retry?.invoke()
            },
            colors = ButtonDefaults.outlinedButtonColors(contentColor = color)
        ) {
            Text(stringResource(if (error.retry != null) R.string.sync_error_try_again else R.string.sync_error_dismiss))
        }
    }
}

/**
 * A quiet "Reconnecting..." strip for the ordinary gap after a disconnect. It waits a
 * second so a fast reconnect shows nothing (iOS `SyncReconnectingNotice`).
 */
@Composable
fun ReconnectingStrip(isDisconnected: Boolean) {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(isDisconnected) {
        visible = false
        if (isDisconnected) {
            delay(1_000)
            visible = true
        }
    }
    AnimatedVisibility(visible = visible) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceContainerHigh.copy(alpha = 0.6f))
                .padding(vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.5.dp)
            Text(
                text = stringResource(R.string.sync_reconnecting),
                style = MaterialTheme.typography.labelSmall,
                color = NimbalystColors.textMuted
            )
        }
    }
}

/**
 * Refresh has failed long enough that the user almost certainly needs to sign in again
 * (iOS `SyncAuthDegradedBanner`). Replaces the reconnecting strip while shown.
 */
@Composable
fun AuthDegradedBanner(onSignIn: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(NimbalystColors.warning.copy(alpha = 0.18f))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Icon(Icons.Default.WarningAmber, contentDescription = null, tint = NimbalystColors.warning, modifier = Modifier.size(18.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.sync_auth_degraded_title),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = stringResource(R.string.sync_auth_degraded_message),
                style = MaterialTheme.typography.bodySmall,
                color = NimbalystColors.textMuted
            )
        }
        Button(
            onClick = onSignIn,
            colors = ButtonDefaults.buttonColors(containerColor = NimbalystColors.primary)
        ) {
            Text(stringResource(R.string.sync_auth_degraded_sign_in))
        }
    }
}

/**
 * Document edits that failed to save, for the shell to show when neither the
 * file list nor the editor (which show their own banner) is on screen. Empty
 * until a document surface has been shown, since only those produce failures.
 */
@Composable
fun appSaveFailures(): List<DocumentSaveFailure> {
    if (!DocumentSurfaces.everShown) return emptyList()
    val context = LocalContext.current
    val manager = remember { Documents.manager(context) }
    val failures by manager.saveFailures.collectAsStateWithLifecycle()
    return if (DocumentSurfaces.isVisible) emptyList() else failures
}

/** The app-level banner for [appSaveFailures], with Copy, Retry, and Discard per edit. */
@Composable
fun AppSaveFailureBanner(failures: List<DocumentSaveFailure>, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    SaveFailureBanner(
        failures = failures,
        onRetry = { Documents.manager(context).retrySave(it) },
        onDiscard = { Documents.manager(context).discardUnsaved(it) },
        modifier = modifier,
    )
}
