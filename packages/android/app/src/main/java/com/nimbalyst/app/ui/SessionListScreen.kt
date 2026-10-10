package com.nimbalyst.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.snapshotFlow
import androidx.annotation.StringRes
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.documents.DocumentListScreen
import com.nimbalyst.app.wiki.WikiTreeScreen
import com.nimbalyst.app.pages.TeamPagesTab
import com.nimbalyst.app.pages.rememberTeamPagesModel
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.ui.navigation.WorkspaceNavigation
import com.nimbalyst.app.ui.sessionlist.CreateKind
import com.nimbalyst.app.ui.sessionlist.CreateMenu
import com.nimbalyst.app.ui.sessionlist.LastUsedModel
import com.nimbalyst.app.ui.sessionlist.ModelPickerDialog
import com.nimbalyst.app.ui.sessionlist.MoveToWorkstreamDialog
import com.nimbalyst.app.ui.sessionlist.RowAction
import com.nimbalyst.app.ui.sessionlist.RowActionsMenu
import com.nimbalyst.app.ui.sessionlist.SessionListActions
import com.nimbalyst.app.ui.sessionlist.actionTargets
import com.nimbalyst.app.ui.sessionlist.resolveModel
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.sessionlist.GroupHeader
import com.nimbalyst.app.ui.sessionlist.GroupKind
import com.nimbalyst.app.ui.sessionlist.PhaseFilter
import com.nimbalyst.app.ui.sessionlist.SectionHeader
import com.nimbalyst.app.ui.navigation.DocumentSurfaceMarker
import com.nimbalyst.app.ui.sessionlist.SearchCoverageNotice
import com.nimbalyst.app.ui.sessionlist.SessionListFilter
import com.nimbalyst.app.ui.sessionlist.SessionListSearch
import com.nimbalyst.app.ui.sessionlist.SessionListGrouping
import com.nimbalyst.app.ui.sessionlist.SessionRow
import com.nimbalyst.app.ui.sessionlist.timePeriodLabel
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Groups the list renders before it needs the next page (iOS pages by the same size). */
private const val PAGE_SIZE = 50

/**
 * Sessions for one project, matching iOS `SessionListView`: search, phase filter,
 * archived view, meta-agent and pinned sections, then time sections of workstream,
 * worktree and standalone rows. Selection is owned by the caller so the list and the
 * detail pane agree across rotation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    projectId: String,
    projectName: String,
    selectedSessionId: String?,
    onSelectSession: (String) -> Unit,
    onBack: () -> Unit,
    hostDeviceId: String? = null,
    includeUnattributedSessions: Boolean = false,
    toolbarActions: @Composable RowScope.() -> Unit = {},
    navigation: WorkspaceNavigation = viewModel(),
    onOpenDocument: (relativePath: String) -> Unit = {},
    /** Switching Sessions/Files drops the detail selection, as on iOS. */
    onTabChanged: () -> Unit = {},
) {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    val sessions by remember(projectId) { app.repository.observeSessionsForProject(projectId) }
        .collectAsState(initial = null)
    val metaAgentEnabled by app.syncManager.metaAgentEnabled.collectAsState()
    val availableModels by app.syncManager.availableModels.collectAsState()
    val desktopDefaultModel by app.syncManager.desktopDefaultModel.collectAsState()
    val nav by navigation.state.collectAsState()
    val coroutineScope = rememberCoroutineScope()

    var selectedTab by rememberSaveable(projectId) { mutableStateOf(ProjectTab.SESSIONS) }
    // Observed, not read once: the project config that names the wiki can arrive while this screen is open.
    val wiki by remember(projectId) {
        app.repository.observeProjects()
            .map { projects -> projects.firstOrNull { it.id == projectId }.let { ProjectWiki(it?.localWikiFolder, it?.localWikiTypesJson) } }
            .distinctUntilChanged()
    }.collectAsState(initial = null)
    val wikiFolder = wiki?.folder
    // The Team tab shows only when this project maps to a team project (or the check failed, with Retry).
    val gitRemoteHash by remember(projectId) {
        app.repository.observeProjects()
            .map { projects -> projects.firstOrNull { it.id == projectId }?.gitRemoteHash }
            .distinctUntilChanged()
    }.collectAsState(initial = null)
    val teamPages = rememberTeamPagesModel(projectId, gitRemoteHash)
    val teamState by teamPages.state.collectAsState()
    LaunchedEffect(teamState) {
        if (teamState.checked && !teamState.isLoading && !teamState.showsTeamTab && selectedTab == ProjectTab.TEAM) {
            selectedTab = ProjectTab.SESSIONS
        }
    }
    // A restored Wiki selection waits for the project row; only a project known to have no wiki resets it.
    LaunchedEffect(wiki) {
        if (wiki != null && wikiFolder == null && selectedTab == ProjectTab.WIKI) selectedTab = ProjectTab.SESSIONS
    }
    var searchText by rememberSaveable(projectId) { mutableStateOf("") }
    // The list filters by the settled query, not every keystroke.
    var appliedSearch by rememberSaveable(projectId) { mutableStateOf(searchText) }
    LaunchedEffect(projectId) {
        SessionListSearch.debounced(snapshotFlow { searchText }).collect { appliedSearch = it }
    }
    val indexCoverage by app.syncManager.indexCoverage.collectAsState()
    val coverageNotice = SessionListSearch.coverageNotice(appliedSearch.isNotBlank(), indexCoverage)
    var phaseFilter by rememberSaveable(projectId) { mutableStateOf(PhaseFilter.ALL) }
    var showArchived by rememberSaveable(projectId) { mutableStateOf(false) }
    // Keys whose expansion differs from the default: workstreams and worktrees start
    // collapsed, meta-agent groups start expanded (mirrors desktop and iOS).
    var toggledGroups by rememberSaveable(projectId) { mutableStateOf(emptyList<String>()) }
    var isRefreshing by remember { mutableStateOf(false) }
    var showCreateMenu by remember { mutableStateOf(false) }
    // A create waiting on the model dialog: the kind and, for "Add Session", its workstream.
    var pendingCreate by remember { mutableStateOf<Pair<CreateKind, SessionListGrouping.Group?>?>(null) }
    var menuTarget by remember { mutableStateOf<String?>(null) }
    var moveTarget by remember { mutableStateOf<SessionEntity?>(null) }

    val lastUsedModel = remember { LastUsedModel(context) }
    var selectedModelId by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(availableModels, desktopDefaultModel) {
        if (selectedModelId == null || availableModels.none { it.id == selectedModelId }) {
            selectedModelId = resolveModel(availableModels, lastUsedModel.get(), desktopDefaultModel)
        }
    }
    val failureFallback = stringResource(R.string.session_create_failed_fallback)
    val actions = remember(projectId, hostDeviceId, navigation) {
        SessionListActions(app, navigation, projectId, hostDeviceId, failureFallback)
    }
    val workstreams = remember(sessions) { SessionListGrouping.workstreamParents(sessions.orEmpty()) }

    val filter = SessionListFilter(
        searchText = appliedSearch,
        phase = phaseFilter,
        includeArchived = showArchived,
        metaAgentEnabled = metaAgentEnabled,
        hostDeviceId = hostDeviceId,
        includeUnattributedSessions = includeUnattributedSessions,
    )
    var windowSize by rememberSaveable(projectId) { mutableStateOf(PAGE_SIZE) }
    LaunchedEffect(filter) { windowSize = PAGE_SIZE }

    val sections by produceState<SessionListGrouping.Sections?>(null, sessions, filter, windowSize) {
        val all = sessions ?: return@produceState
        value = withContext(Dispatchers.Default) {
            SessionListGrouping.sections(
                groups = SessionListGrouping.buildGroups(all, filter),
                facets = SessionListGrouping.facets(all),
                windowSize = windowSize,
            )
        }
    }
    val facets = sections?.facets

    // A filter the list can no longer show (archives emptied, phases gone) resets itself.
    LaunchedEffect(facets) {
        if (facets == null) return@LaunchedEffect
        if (!facets.hasArchived && showArchived) showArchived = false
        if (!facets.hasPhaseData && phaseFilter != PhaseFilter.ALL) phaseFilter = PhaseFilter.ALL
    }

    fun isExpanded(group: SessionListGrouping.Group): Boolean = group.key in toggledGroups

    fun toggle(group: SessionListGrouping.Group) {
        toggledGroups = if (group.key in toggledGroups) toggledGroups - group.key else toggledGroups + group.key
    }

    fun expand(key: String) {
        toggledGroups = toggledGroups + key
    }

    fun create(kind: CreateKind, modelId: String?, workstream: SessionListGrouping.Group?) {
        actions.create(kind, modelId, parentSessionId = workstream?.parent?.id)
        workstream?.let { expand(it.key) }
    }

    /** Ask for the model first; with no list from the desktop yet, it picks its default. */
    fun requestCreate(kind: CreateKind, workstream: SessionListGrouping.Group? = null) {
        if (availableModels.isEmpty()) create(kind, null, workstream) else pendingCreate = kind to workstream
    }

    fun perform(group: SessionListGrouping.Group, action: RowAction) {
        val targets = actionTargets(group)
        when (action) {
            RowAction.ADD_SESSION -> requestCreate(CreateKind.SESSION, group)
            RowAction.START_WORKSTREAM -> actions.startWorkstream(group.parent)
            RowAction.MOVE_TO_WORKSTREAM -> moveTarget = group.parent
            RowAction.ARCHIVE, RowAction.UNARCHIVE -> {
                val archive = action == RowAction.ARCHIVE
                actions.setArchived(targets, archive)
                if (archive && !showArchived && selectedSessionId in targets) navigation.select(null)
            }
            RowAction.DELETE -> {
                actions.delete(targets)
                if (selectedSessionId in targets) navigation.select(null)
            }
        }
    }

    val rowMenu: @Composable (SessionListGrouping.Group) -> Unit = { group ->
        RowActionsMenu(
            expanded = menuTarget == group.key,
            group = group,
            hasWorkstreams = workstreams.any { it.id != group.parent.id },
            onDismiss = { menuTarget = null },
            onAction = { perform(group, it) }
        )
    }
    val onLongPress: (SessionListGrouping.Group) -> Unit = { menuTarget = it.key }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        TopAppBar(
            title = { Text(projectName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.session_list_projects))
                }
            },
            actions = {
                if (selectedTab == ProjectTab.SESSIONS && facets?.hasArchived == true) {
                    IconButton(onClick = { showArchived = !showArchived }) {
                        Icon(
                            imageVector = if (showArchived) Icons.Filled.Archive else Icons.Outlined.Archive,
                            contentDescription = stringResource(
                                if (showArchived) R.string.session_list_hide_archived else R.string.session_list_show_archived
                            ),
                            tint = if (showArchived) NimbalystColors.primary else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                toolbarActions()
                if (selectedTab == ProjectTab.SESSIONS) Box {
                    val isCreating = nav.pendingCreations.isNotEmpty()
                    IconButton(onClick = { showCreateMenu = true }, enabled = !isCreating) {
                        if (isCreating) {
                            CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Default.Add, contentDescription = stringResource(R.string.session_list_create))
                        }
                    }
                    CreateMenu(
                        expanded = showCreateMenu,
                        metaAgentEnabled = metaAgentEnabled,
                        onDismiss = { showCreateMenu = false },
                        onCreate = { kind -> requestCreate(kind) },
                        onCreateWorktree = actions::createWorktree,
                    )
                }
            }
        )

        ProjectTabRow(selected = selectedTab, tabs = projectTabs(wikiFolder != null, teamState.showsTeamTab), onSelect = { tab ->
            if (tab != selectedTab) {
                selectedTab = tab
                onTabChanged()
            }
        })

        if (selectedTab == ProjectTab.WIKI && wikiFolder != null) {
            DocumentSurfaceMarker()
            WikiTreeScreen(
                projectId = projectId,
                folder = wikiFolder,
                typesJson = wiki?.typesJson,
                onOpenDocument = onOpenDocument,
                modifier = Modifier.fillMaxSize(),
            )
        } else if (selectedTab == ProjectTab.TEAM) {
            TeamPagesTab(model = teamPages, modifier = Modifier.fillMaxSize())
        } else if (selectedTab == ProjectTab.FILES) {
            DocumentSurfaceMarker()
            DocumentListScreen(
                projectId = projectId,
                onOpenDocument = onOpenDocument,
                modifier = Modifier.fillMaxSize(),
                wikiFolder = wikiFolder,
            )
        } else {
            SearchField(value = searchText, onValueChange = { searchText = it })

            if (facets?.hasPhaseData == true) {
                PhaseFilterRow(selected = phaseFilter, onSelect = { phaseFilter = it })
            }

            PullToRefreshBox(
                isRefreshing = isRefreshing,
                onRefresh = {
                    isRefreshing = true
                    app.syncManager.requestFullSync()
                    coroutineScope.launch {
                        delay(1000)
                        isRefreshing = false
                    }
                },
                modifier = Modifier.fillMaxSize()
            ) {
                val current = sections
                when {
                    current == null -> Unit
                    current.isEmpty -> EmptyState(isSearching = appliedSearch.isNotBlank(), notice = coverageNotice)
                    else -> LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(start = 8.dp, end = 8.dp, bottom = 24.dp)
                    ) {
                        if (coverageNotice != SearchCoverageNotice.NONE) {
                            item(key = "search-coverage") { SearchCoverageRow(coverageNotice) }
                        }
                        if (current.pinned.isNotEmpty()) {
                            item(key = "h-pinned") { SectionHeader(stringResource(R.string.session_list_section_pinned)) }
                            groupItems(current.pinned, selectedSessionId, ::isExpanded, ::toggle, onSelectSession, onLongPress, rowMenu)
                        }
                        current.timeline.forEach { (period, groups) ->
                            item(key = "h-${period.name}") { SectionHeader(timePeriodLabel(period)) }
                            groupItems(groups, selectedSessionId, ::isExpanded, ::toggle, onSelectSession, onLongPress, rowMenu)
                        }
                        if (current.hasMore) {
                            item(key = "page-loader") {
                                // Pull the next page in as the loader scrolls into view.
                                LaunchedEffect(current) { windowSize += PAGE_SIZE }
                                Box(modifier = Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pendingCreate?.let { (kind, workstream) ->
        ModelPickerDialog(
            title = stringResource(
                when {
                    workstream != null -> R.string.session_action_add_session
                    kind == CreateKind.WORKSTREAM -> R.string.session_list_new_workstream
                    kind == CreateKind.META_AGENT -> R.string.session_list_new_meta_agent
                    else -> R.string.session_list_new_session
                }
            ),
            models = availableModels,
            initialModelId = selectedModelId,
            onCreate = { id ->
                pendingCreate = null
                selectedModelId = id
                lastUsedModel.set(id)
                create(kind, id, workstream)
            },
            onDismiss = { pendingCreate = null }
        )
    }
    moveTarget?.let { session ->
        MoveToWorkstreamDialog(
            workstreams = workstreams.filter { it.id != session.id },
            onPick = { ws ->
                moveTarget = null
                actions.moveToWorkstream(session.id, ws.id)
                expand("ws:${ws.id}")
            },
            onDismiss = { moveTarget = null }
        )
    }
}

private fun LazyListScope.groupItems(
    groups: List<SessionListGrouping.Group>,
    selectedSessionId: String?,
    isExpanded: (SessionListGrouping.Group) -> Boolean,
    toggle: (SessionListGrouping.Group) -> Unit,
    onSelectSession: (String) -> Unit,
    onLongPress: (SessionListGrouping.Group) -> Unit,
    rowMenu: @Composable (SessionListGrouping.Group) -> Unit,
) {
    groups.forEach { group ->
        if (group.kind == GroupKind.STANDALONE) {
            item(key = group.key) {
                Box {
                    SessionRow(
                        session = group.parent,
                        isSelected = group.parent.id == selectedSessionId,
                        onClick = { onSelectSession(group.parent.id) },
                        onLongClick = { onLongPress(group) }
                    )
                    rowMenu(group)
                }
            }
            return@forEach
        }
        val expanded = isExpanded(group)
        item(key = group.key) {
            val headerIsSession = group.kind == GroupKind.WORKSTREAM &&
                group.parent.sessionType != SessionListGrouping.WORKSTREAM_TYPE
            Box {
                GroupHeader(
                    group = group,
                    isExpanded = expanded,
                    // Ordinary tree roots remain selectable; wrappers only expand.
                    isSelected = (headerIsSession || group.children.isEmpty()) && group.parent.id == selectedSessionId,
                    onClick = {
                        if (headerIsSession || group.children.isEmpty()) onSelectSession(group.parent.id) else toggle(group)
                    },
                    onLongClick = { onLongPress(group) },
                    onToggleExpanded = if (headerIsSession && group.children.isNotEmpty()) ({ toggle(group) }) else null
                )
                rowMenu(group)
            }
        }
        if (expanded) {
            group.children.forEach { child ->
                item(key = "${group.key}/${child.id}") {
                    SessionRow(
                        session = child,
                        isSelected = child.id == selectedSessionId,
                        onClick = { onSelectSession(child.id) },
                        onLongClick = null,
                        isChild = true,
                        treeIndentationLevel = SessionListGrouping.indentationLevel(child, group)
                    )
                }
            }
        }
    }
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        placeholder = { Text(stringResource(R.string.session_list_search_placeholder)) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = if (value.isNotEmpty()) {
            {
                IconButton(onClick = { onValueChange("") }) {
                    Icon(Icons.Default.Clear, contentDescription = stringResource(R.string.session_list_clear_search))
                }
            }
        } else {
            null
        },
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    )
}

/** Sessions | Files | Wiki | Team, like iOS `ProjectTab`. */
internal enum class ProjectTab { SESSIONS, FILES, WIKI, TEAM }

/** Wiki only when the project has a Local wiki; Team only when it maps to a team project. */
internal fun projectTabs(hasWiki: Boolean, hasTeam: Boolean = false): List<ProjectTab> =
    ProjectTab.entries.filter { (it != ProjectTab.WIKI || hasWiki) && (it != ProjectTab.TEAM || hasTeam) }

private data class ProjectWiki(val folder: String?, val typesJson: String?)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProjectTabRow(selected: ProjectTab, tabs: List<ProjectTab>, onSelect: (ProjectTab) -> Unit) {
    SingleChoiceSegmentedButtonRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    ) {
        tabs.forEachIndexed { index, tab ->
            SegmentedButton(
                selected = tab == selected,
                onClick = { onSelect(tab) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = tabs.size),
                icon = {}
            ) {
                Text(
                    stringResource(
                        when (tab) {
                            ProjectTab.SESSIONS -> R.string.session_list_tab_sessions
                            ProjectTab.FILES -> R.string.session_list_tab_files
                            ProjectTab.WIKI -> R.string.session_list_tab_wiki
                            ProjectTab.TEAM -> R.string.session_list_tab_team
                        }
                    ),
                    style = MaterialTheme.typography.labelMedium
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PhaseFilterRow(selected: PhaseFilter, onSelect: (PhaseFilter) -> Unit) {
    val options = PhaseFilter.entries
    SingleChoiceSegmentedButtonRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    ) {
        options.forEachIndexed { index, option ->
            SegmentedButton(
                selected = option == selected,
                onClick = { onSelect(option) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                icon = {}
            ) {
                Text(
                    text = stringResource(
                        when (option) {
                            PhaseFilter.ALL -> R.string.session_list_phase_all
                            PhaseFilter.ACTIVE -> R.string.session_list_phase_active
                            PhaseFilter.PLANNING -> R.string.session_list_phase_planning
                            PhaseFilter.COMPLETE -> R.string.session_list_phase_done
                        }
                    ),
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1
                )
            }
        }
    }
}

@StringRes
private fun SearchCoverageNotice.description(): Int = when (this) {
    SearchCoverageNotice.FAILED -> R.string.session_list_history_failed
    SearchCoverageNotice.LEGACY_SERVER -> R.string.session_list_history_legacy
    else -> R.string.session_list_history_syncing
}

/** Shown above search results that may not be the whole answer yet. */
@Composable
private fun SearchCoverageRow(notice: SearchCoverageNotice) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        if (notice == SearchCoverageNotice.SYNCING) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
        }
        Text(
            text = stringResource(notice.description()),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun EmptyState(isSearching: Boolean, notice: SearchCoverageNotice) {
    // Box + fillMaxSize keeps pull-to-refresh reachable on an empty list.
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = stringResource(
                when {
                    !isSearching -> R.string.session_list_empty
                    // An empty result is only definitive once history is complete.
                    notice == SearchCoverageNotice.NONE -> R.string.session_list_no_matches
                    notice == SearchCoverageNotice.SYNCING -> R.string.session_list_search_still_checking
                    else -> notice.description()
                }
            ),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
    }
}
