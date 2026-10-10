package com.nimbalyst.app.pages

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.R
import com.nimbalyst.app.transcript.TranscriptExternalLinks
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.launch

/**
 * Hosts the Pages screen above the app shell: a full-screen destination that any
 * inbound console link, Team tab row or App Link opens through [ConsoleLinkInbox].
 * [onAppLink] receives the app routes a console page links to.
 */
@Composable
fun PagesHost(onAppLink: (NimbalystAppLink) -> Unit, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val runtime = remember { ConsolePages.runtime(context) }
    val route by runtime.inbox.route.collectAsState()
    val personalRequested by runtime.inbox.personalPageRequested.collectAsState()

    LaunchedEffect(runtime) {
        runtime.appLinks.collect { link ->
            // The controller keeps the page (and any edits) alive; only the screen closes.
            runtime.inbox.close()
            onAppLink(link)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        content()
        route?.let { current ->
            PagesScreen(
                runtime = runtime,
                route = current,
                onLeave = { runtime.inbox.close() },
                onKeepRoute = { kept -> runtime.inbox.open(kept) },
            )
        }
    }

    if (personalRequested) {
        InfoDialog(
            title = stringResource(R.string.pages_personal_title),
            message = stringResource(R.string.pages_personal_message),
            onDismiss = { runtime.inbox.personalPageNoticeShown() },
        )
    }
}

/** A team's Wiki or Trackers from the web console. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PagesScreen(
    runtime: ConsolePagesRuntime,
    route: ConsoleRoute,
    onLeave: () -> Unit,
    /** A replacement the reader refused: re-select the page still on screen. */
    onKeepRoute: (ConsoleRoute) -> Unit,
) {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    // Recompose on sign-in and sign-out; the runtime reads the selection itself.
    val pairing by app.pairingStore.state.collectAsState()
    val controllerValue by runtime.controller.collectAsState()
    val account = remember(pairing) { runtime.account() }
    val controller = controllerValue?.takeIf { it.account == account && !it.isTornDown }
    val fallbackTitle = stringResource(if (route.path.contains("/trackers")) R.string.pages_team_trackers else R.string.pages_team_wiki)

    if (controller != null) {
        PagesContent(controller, route, fallbackTitle, onLeave, onKeepRoute)
        return
    }

    BackHandler { onLeave() }
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        PagesTopBar(title = fallbackTitle, unsynced = false, onBack = onLeave)
        Box(modifier = Modifier.fillMaxSize().navigationBarsPadding(), contentAlignment = Alignment.Center) {
            when {
                // No per-account profile support means no Pages: never a shared-profile fallback.
                !runtime.support.supported -> Unavailable(
                    title = stringResource(R.string.pages_webview_unsupported_title),
                    message = stringResource(R.string.pages_webview_unsupported_message),
                    actionLabel = stringResource(R.string.pages_webview_update),
                    onAction = { openWebViewListing(context) },
                )
                account == null -> Unavailable(
                    title = stringResource(R.string.pages_sign_in_title),
                    message = stringResource(R.string.pages_sign_in_message),
                )
                else -> {
                    CircularProgressIndicator()
                    LaunchedEffect(account) { runtime.prepareController() }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PagesContent(
    controller: PagesWebController,
    route: ConsoleRoute,
    fallbackTitle: String,
    onLeave: () -> Unit,
    onKeepRoute: (ConsoleRoute) -> Unit,
) {
    val context = LocalContext.current
    val state by controller.state.collectAsState()
    val pendingLeave by controller.navigator.pendingLeave.collectAsState()
    val scope = rememberCoroutineScope()

    // Team tab rows, links and pushes all replace the page through the leave guard.
    LaunchedEffect(controller, route) { controller.requestOpen(route) }

    fun back() {
        scope.launch { if (controller.requestBack()) onLeave() }
    }

    fun keepEditing() {
        controller.navigator.cancelPendingLeave()?.let { kept -> if (kept != route) onKeepRoute(kept) }
    }

    BackHandler { back() }

    val failed = state.phase is PagesPhase.Failed
    Column(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        PagesTopBar(title = state.title.ifEmpty { fallbackTitle }, unsynced = state.unsynced, onBack = ::back)
        if (state.lostEditsNotice) LostEditsBanner(onDismiss = controller::dismissLostEditsNotice)
        Box(
            modifier = Modifier.fillMaxSize().navigationBarsPadding().imePadding(),
            contentAlignment = Alignment.Center,
        ) {
            // The controller's WebView is moved into each new container, so leaving and
            // reopening the screen never creates a second WebView. A new version means
            // the render process died and the WebView was replaced.
            key(state.webViewVersion) {
                AndroidView(
                    factory = { FrameLayout(it) },
                    update = { container ->
                        val webView = controller.webView
                        if (webView.parent !== container) {
                            (webView.parent as? ViewGroup)?.removeView(webView)
                            container.addView(webView)
                        }
                    },
                    onRelease = { container -> container.removeAllViews() },
                    modifier = Modifier.fillMaxSize().alpha(if (failed) 0f else 1f),
                )
            }
            when (val phase = state.phase) {
                PagesPhase.Loading -> CircularProgressIndicator()
                is PagesPhase.Failed -> Failure(phase.failure, onRetry = { scope.launch { controller.retry() } })
                PagesPhase.Idle, PagesPhase.Ready -> Unit
            }
        }
    }

    pendingLeave?.let {
        AlertDialog(
            onDismissRequest = ::keepEditing,
            title = { Text(stringResource(R.string.pages_leave_title)) },
            text = { Text(stringResource(R.string.pages_leave_message)) },
            confirmButton = {
                TextButton(onClick = {
                    val leave = controller.navigator.confirmPendingLeave() ?: return@TextButton
                    scope.launch { if (leave()) onLeave() }
                }) { Text(stringResource(R.string.pages_leave_confirm), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = ::keepEditing) { Text(stringResource(R.string.pages_leave_keep_editing)) } },
        )
    }

    when (val sheet = state.sheet) {
        null -> Unit
        PagesSheet.PersonalPages -> InfoDialog(
            title = stringResource(R.string.pages_personal_title),
            message = stringResource(R.string.pages_personal_message),
            onDismiss = controller::dismissSheet,
        )
        PagesSheet.DesktopOnly -> InfoDialog(
            title = stringResource(R.string.pages_desktop_only_title),
            message = stringResource(R.string.pages_desktop_only_message),
            onDismiss = controller::dismissSheet,
        )
        is PagesSheet.OrgAuthRequired -> AlertDialog(
            onDismissRequest = controller::dismissSheet,
            title = { Text(stringResource(R.string.pages_org_auth_title)) },
            text = { Text(stringResource(R.string.pages_org_auth_message)) },
            confirmButton = {
                TextButton(onClick = {
                    controller.dismissSheet()
                    TranscriptExternalLinks.open(context, controller.environment.originString)
                }) { Text(stringResource(R.string.pages_open_in_browser)) }
            },
            dismissButton = { TextButton(onClick = controller::dismissSheet) { Text(stringResource(R.string.pages_cancel)) } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PagesTopBar(title: String, unsynced: Boolean, onBack: () -> Unit) {
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.pages_back))
            }
        },
        actions = {
            if (unsynced) {
                Row(
                    modifier = Modifier.padding(end = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(Icons.Outlined.CloudOff, contentDescription = null, tint = UNSYNCED, modifier = Modifier.size(16.dp))
                    Text(stringResource(R.string.pages_not_saved), style = MaterialTheme.typography.labelMedium, color = UNSYNCED)
                }
            }
        },
    )
}

@Composable
private fun LostEditsBanner(onDismiss: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(UNSYNCED.copy(alpha = 0.15f))
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.ErrorOutline, contentDescription = null, modifier = Modifier.size(16.dp))
        Text(
            stringResource(R.string.pages_lost_edits),
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
        )
        IconButton(onClick = onDismiss) {
            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.pages_dismiss))
        }
    }
}

@Composable
private fun Failure(failure: PagesFailure, onRetry: () -> Unit) {
    val (title, message) = when (failure) {
        PagesFailure.Offline -> stringResource(R.string.pages_offline_title) to stringResource(R.string.pages_offline_message)
        is PagesFailure.Load -> stringResource(R.string.pages_load_failed_title) to
            (failure.detail ?: stringResource(R.string.pages_load_failed_message))
        PagesFailure.InvalidAddress -> stringResource(R.string.pages_load_failed_title) to stringResource(R.string.pages_invalid_address)
        PagesFailure.Stopped -> stringResource(R.string.pages_load_failed_title) to stringResource(R.string.pages_stopped)
        is PagesFailure.Server -> stringResource(R.string.pages_load_failed_title) to stringResource(R.string.pages_server_error, failure.status)
        is PagesFailure.Session -> stringResource(R.string.pages_session_failed_title) to stringResource(
            when (failure.kind) {
                PagesSessionFailure.NOT_A_MEMBER -> R.string.pages_session_not_a_member
                PagesSessionFailure.UNAVAILABLE -> R.string.pages_session_unavailable
                PagesSessionFailure.ORG_AUTH_REQUIRED -> R.string.pages_org_auth_title
                PagesSessionFailure.NETWORK -> R.string.pages_session_network
                PagesSessionFailure.SIGN_IN_REFRESH -> R.string.pages_session_refresh
                PagesSessionFailure.GENERIC -> R.string.pages_session_generic
            }
        )
    }
    Unavailable(
        title = title,
        message = message,
        actionLabel = stringResource(R.string.pages_retry),
        onAction = onRetry,
        offline = failure == PagesFailure.Offline,
    )
}

@Composable
private fun Unavailable(
    title: String,
    message: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    offline: Boolean = false,
) {
    Column(
        modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            if (offline) Icons.Outlined.CloudOff else Icons.Outlined.ErrorOutline,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = onAction) { Text(actionLabel) }
        }
    }
}

/** Android System WebView's store listing: the Play Store app, else the web page in a Custom Tab. */
private fun openWebViewListing(context: Context) {
    val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$WEBVIEW_PACKAGE")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(market)
    } catch (_: ActivityNotFoundException) {
        TranscriptExternalLinks.open(context, "https://play.google.com/store/apps/details?id=$WEBVIEW_PACKAGE")
    }
}

private const val WEBVIEW_PACKAGE = "com.google.android.webview"

@Composable
private fun InfoDialog(title: String, message: String, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.pages_ok)) } },
    )
}

private val UNSYNCED = NimbalystColors.warning
