package com.nimbalyst.app.ui.navigation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.SessionDetailScreen
import com.nimbalyst.app.ui.components.NimbalystSecondaryButton
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.delay

/** How long to wait before telling the user the session has not synced yet (iOS: 30s). */
internal const val PENDING_SESSION_TIMEOUT_MS = 30_000L

/**
 * Hosts a session that may not exist on this device yet, like iOS `PendingSessionView`.
 * A notification about a just-created session names a row that has not synced; waiting
 * for it keeps the tap from silently doing nothing. A late arrival still opens it.
 */
@Composable
fun PendingSessionScreen(
    sessionId: String,
    onBack: () -> Unit,
    onResolved: (projectId: String) -> Unit,
    /** A launcher action in the session created another session; open it like a list pick. */
    onOpenSession: (String) -> Unit = {},
) {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    // `Unit` = still loading from Room; null = Room answered and the row is absent.
    val session by remember(sessionId) { app.repository.observeSession(sessionId) }
        .collectAsState(initial = Unit)
    var didTimeOut by rememberSaveable(sessionId) { mutableStateOf(false) }

    val resolved = session as? com.nimbalyst.app.data.SessionEntity
    LaunchedEffect(resolved?.projectId) {
        resolved?.let { onResolved(it.projectId) }
    }
    // Ask for this one row ahead of background history once Room says it is missing.
    LaunchedEffect(sessionId, session == null) {
        if (session == null) app.syncManager.requestSessionIndexLookup(sessionId)
    }
    LaunchedEffect(sessionId, resolved == null) {
        if (resolved == null && !didTimeOut) {
            delay(PENDING_SESSION_TIMEOUT_MS)
            didTimeOut = true
        }
    }

    if (resolved != null) {
        SessionDetailScreen(sessionId = sessionId, onBack = onBack, onOpenSession = onOpenSession)
        return
    }
    // Don't flash the waiting state on the warm path while Room answers.
    if (session == Unit) return

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically)
    ) {
        if (didTimeOut) {
            Icon(
                imageVector = Icons.Default.Refresh,
                contentDescription = null,
                tint = NimbalystColors.textFaint,
                modifier = Modifier.size(40.dp)
            )
            Text(stringResource(R.string.pending_session_still_syncing), style = MaterialTheme.typography.titleMedium)
            Text(
                text = stringResource(R.string.pending_session_still_syncing_detail),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
            NimbalystSecondaryButton(
                text = stringResource(R.string.pending_session_retry),
                onClick = {
                    app.syncManager.requestFullSync()
                    app.syncManager.requestSessionIndexLookup(sessionId)
                }
            )
        } else {
            CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
            Text(
                text = stringResource(R.string.pending_session_opening),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
