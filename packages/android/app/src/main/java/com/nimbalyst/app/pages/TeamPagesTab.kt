package com.nimbalyst.app.pages

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.R
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/** What the Team tab knows about one phone project. */
data class TeamPagesState(
    val mapping: ConsoleProjectMapping = ConsoleProjectMapping.Unmapped,
    val allMatches: List<ConsoleTeamProjectMatch> = emptyList(),
    /** The team directory could not be read, so "no team" is unknown, not an answer. */
    val discoveryFailed: Boolean = false,
    val isLoading: Boolean = false,
    /** At least one check finished, so an empty answer is real. */
    val checked: Boolean = false,
) {
    /** A mapped project, or one whose mapping could not be checked (with Retry). */
    val showsTeamTab: Boolean get() = mapping != ConsoleProjectMapping.Unmapped || discoveryFailed
}

/**
 * Whether a phone project has a team project, loaded from the team directory with
 * the personal JWT. Only mapped projects get Team Wiki and Team Trackers rows.
 */
class TeamPagesModel(
    private val projectId: String,
    private val broker: ConsoleSessionBroker,
    private val isSignedIn: () -> Boolean,
) {
    private val _state = MutableStateFlow(TeamPagesState())
    val state: StateFlow<TeamPagesState> = _state.asStateFlow()
    private var gitRemoteHash: String? = null

    suspend fun load(gitRemoteHash: String?) {
        if (this.gitRemoteHash != gitRemoteHash) _state.value = TeamPagesState()
        this.gitRemoteHash = gitRemoteHash
        if (gitRemoteHash.isNullOrEmpty() || !isSignedIn()) {
            _state.value = TeamPagesState(checked = true)
            return
        }
        _state.value = _state.value.copy(isLoading = true)
        val outcome = broker.teams()
        if (this.gitRemoteHash != gitRemoteHash) return
        _state.value = when (outcome) {
            is ConsoleTeamsOutcome.Loaded -> TeamPagesState(
                mapping = ConsoleTeamResolver.mapping(gitRemoteHash, outcome.teams, broker.rememberedOrgId(projectId)),
                allMatches = ConsoleTeamResolver.matches(gitRemoteHash, outcome.teams),
                checked = true,
            )
            is ConsoleTeamsOutcome.Failed -> when {
                // A newer selection takes over; its own load answers.
                outcome.reason == "signed_out" || outcome.reason == "account_changed" -> _state.value.copy(isLoading = false)
                // Keep a mapping already shown; otherwise say the check failed.
                else -> _state.value.copy(
                    isLoading = false,
                    checked = true,
                    discoveryFailed = _state.value.mapping == ConsoleProjectMapping.Unmapped,
                )
            }
        }
    }

    suspend fun retry() = load(gitRemoteHash)

    fun choose(match: ConsoleTeamProjectMatch) {
        broker.rememberOrgChoice(match.orgId, projectId)
        _state.value = _state.value.copy(mapping = ConsoleProjectMapping.Mapped(match))
    }

    fun chooseAgain() {
        val all = _state.value.allMatches
        if (all.size > 1) _state.value = _state.value.copy(mapping = ConsoleProjectMapping.NeedsChoice(all))
    }
}

/** The project's Team tab model, reloaded on sign-in, sign-out and a new remote. */
@Composable
fun rememberTeamPagesModel(projectId: String, gitRemoteHash: String?): TeamPagesModel {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    val runtime = remember { ConsolePages.runtime(context) }
    val model = remember(projectId) { TeamPagesModel(projectId, runtime.broker) { runtime.account() != null } }
    val pairing by app.pairingStore.state.collectAsState()
    val accountKey = remember(pairing) { runtime.account()?.let { "${it.accountId}:${it.generation}" } }
    LaunchedEffect(model, gitRemoteHash, accountKey) { model.load(gitRemoteHash) }
    // A failed check is retried when the device comes back online.
    LaunchedEffect(model) {
        runtime.reachability.isOnline.drop(1).filter { it }.collect {
            if (model.state.value.discoveryFailed) model.retry()
        }
    }
    return model
}

/**
 * The Team tab: the team console's Wiki and Trackers for this project. Kept apart
 * from the local Wiki tab, which reads the project's own markdown.
 */
@Composable
fun TeamPagesTab(model: TeamPagesModel, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val runtime = remember { ConsolePages.runtime(context) }
    val state by model.state.collectAsState()
    val scope = rememberCoroutineScope()

    LazyColumn(modifier = modifier) {
        when (val mapping = state.mapping) {
            is ConsoleProjectMapping.Mapped -> {
                item { SectionTitle(mapping.match.orgName) }
                mapping.match.wikiRoute?.let { route ->
                    item { TeamRow(Icons.AutoMirrored.Outlined.MenuBook, stringResource(R.string.pages_team_wiki)) { runtime.inbox.open(route) } }
                }
                mapping.match.trackersRoute?.let { route ->
                    item { TeamRow(Icons.Outlined.Checklist, stringResource(R.string.pages_team_trackers)) { runtime.inbox.open(route) } }
                }
                if (state.allMatches.size > 1) {
                    item {
                        TextButton(onClick = model::chooseAgain, modifier = Modifier.padding(horizontal = 8.dp)) {
                            Text(stringResource(R.string.pages_team_choose_again))
                        }
                    }
                }
            }
            is ConsoleProjectMapping.NeedsChoice -> {
                item { SectionTitle(stringResource(R.string.pages_team_choose_title)) }
                items(mapping.matches, key = { it.id }) { match ->
                    TeamRow(icon = null, label = match.orgName) { model.choose(match) }
                }
                item { Footnote(stringResource(R.string.pages_team_choose_footer)) }
            }
            ConsoleProjectMapping.Unmapped -> if (state.discoveryFailed) {
                item { SectionTitle(stringResource(R.string.pages_team_discovery_failed_title)) }
                item {
                    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        if (state.isLoading) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            TextButton(onClick = { scope.launch { model.retry() } }) {
                                Icon(Icons.Outlined.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                                Text(stringResource(R.string.pages_retry), modifier = Modifier.padding(start = 6.dp))
                            }
                        }
                    }
                }
                item { Footnote(stringResource(R.string.pages_team_discovery_failed_footer)) }
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun Footnote(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
    )
}

@Composable
private fun TeamRow(icon: ImageVector?, label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}
