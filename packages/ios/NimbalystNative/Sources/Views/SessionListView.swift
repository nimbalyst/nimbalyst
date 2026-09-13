import SwiftUI
import Combine
import GRDB

/// Displays sessions for a given project with status badges, pull-to-refresh,
/// search, hierarchical grouping, and reactive GRDB observation.
///
/// The list renders a bounded window: filtering, hierarchy grouping and aggregate
/// status all run in SQL (`SessionListQueries.swift`), and `SessionListWindowModel`
/// holds at most a few hundred projected rows regardless of how much history the
/// account has retained. Row views live in `SessionListRows.swift`.
public struct SessionListView: View {
    @EnvironmentObject var appState: AppState
    public let project: Project
    public let hostDeviceId: String?
    @Binding private var selection: WorkspaceSelection?

    @StateObject private var model = SessionListWindowModel()
    /// Workstream/worktree groups the user has opened (default collapsed).
    @State private var expandedGroupKeys: Set<String> = []
    /// Meta-agent groups the user has closed (default expanded, mirroring desktop).
    @State private var collapsedMetaAgents: Set<String> = []
    @State private var selectedTab: ProjectTab = .sessions

    public init(project: Project, selection: Binding<WorkspaceSelection?>, hostDeviceId: String? = nil) {
        self.project = project
        self.hostDeviceId = hostDeviceId
        _selection = selection
    }

    @State private var searchText = ""
    @State private var isCreatingSession = false
    @State private var phaseFilter: PhaseFilter = .all
    @State private var showArchived = false
    @State private var selectedModelId: String?
    @State private var showModelPicker = false
    /// Desktop-controlled alpha gate for the Meta Agent UI, synced via SyncedSettings.
    @State private var metaAgentEnabled = FeaturePreferences.metaAgentEnabled
    /// Cached results remain usable while replication establishes full coverage.
    @State private var coverage = IndexCoverage()

    private var historyComplete: Bool { coverage.historyComplete }

    private var historyCoverage: AnyPublisher<IndexCoverage, Never> {
        appState.syncManager?.$indexCoverage
            .removeDuplicates {
                $0.historyComplete == $1.historyComplete && $0.hasError == $1.hasError
                    && $0.compatibility == $1.compatibility
            }
            .eraseToAnyPublisher()
        ?? Just(IndexCoverage(historyComplete: appState.screenshotMode)).eraseToAnyPublisher()
    }

    private var voiceFocusedSessionId: String? {
        #if os(iOS)
        guard let voice = appState.voiceAgent, voice.state != .disconnected else { return nil }
        return voice.activeSessionId
        #else
        return nil
        #endif
    }

    /// Everything the window query filters on. Any change to this restarts the
    /// observation, so it is deliberately the only input the query depends on.
    private var filter: SessionListFilter {
        SessionListFilter(
            projectId: project.id,
            includeArchived: showArchived,
            searchText: searchText.isEmpty ? nil : searchText,
            phase: phaseFilter,
            metaAgentEnabled: metaAgentEnabled,
            hostDeviceId: hostDeviceId
        )
    }

    private var selectedSessionId: String? {
        if case .session(let id) = selection { return id }
        return nil
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Sessions | Files segmented control
            Picker("Tab", selection: $selectedTab) {
                ForEach(ProjectTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            // Tab content
            switch selectedTab {
            case .sessions:
                sessionListContent
            case .files:
                DocumentListView(project: project, selection: $selection)
                    .environmentObject(appState)
            }
        }
        .navigationTitle(project.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .onChange(of: selectedTab) { _, _ in
            selection = nil
        }
        .toolbar { toolbarContent }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerView(
                models: appState.availableModels,
                selectedModelId: $selectedModelId,
                onDismiss: { showModelPicker = false }
            )
            .presentationDetents([.medium, .large])
        }
        .onAppear {
            loadExpandedState()
            metaAgentEnabled = FeaturePreferences.metaAgentEnabled
            appState.configureVoiceAgent(forProject: project.id)
            resolveDefaultModel()
        }
        .task(id: appState.databaseManager.map(ObjectIdentifier.init)) {
            model.setPersistedExpansion(expandedKeys: expandedGroupKeys, collapsedKeys: collapsedMetaAgentKeys)
            model.start(database: appState.databaseManager, filter: filter)
            model.setFocus(sessionId: selectedSessionId)
            model.isHistoryComplete = historyComplete
        }
        .onChange(of: historyComplete) { _, complete in
            model.isHistoryComplete = complete
        }
        .onReceive(historyCoverage) { coverage = $0 }
        .onChange(of: filter) { _, newFilter in
            model.setFilter(newFilter)
        }
        .onChange(of: selectedSessionId) { _, newValue in
            model.setFocus(sessionId: newValue)
        }
        .onChange(of: appState.availableModels) { _, _ in
            resolveDefaultModel()
        }
        .onChange(of: project.id) { _, _ in
            loadExpandedState()
            model.setPersistedExpansion(expandedKeys: expandedGroupKeys, collapsedKeys: collapsedMetaAgentKeys)
            model.start(database: appState.databaseManager, filter: filter)
        }
        .onDisappear {
            model.stop()
        }
        // Refresh the meta-agent gate at the root so a desktop flip is caught even when the
        // user is on a non-Sessions tab. The creation menu's listener is only mounted while
        // `selectedTab == .sessions`, so it misses flips made on other tabs.
        .onReceive(NotificationCenter.default.publisher(for: .init("MetaAgentEnabledSynced"))) { _ in
            metaAgentEnabled = FeaturePreferences.metaAgentEnabled
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            HStack(spacing: 12) {
                #if os(iOS)
                if let voice = appState.voiceAgent, voice.state != .disconnected {
                    VoiceStatusPill(state: voice.state)
                }
                #endif
                if selectedTab == .sessions && model.facets.hasArchived {
                    archiveToggle
                }
                connectionIndicator
                if selectedTab == .sessions {
                    creationMenu
                }
            }
        }
    }

    private var archiveToggle: some View {
        Button {
            withAnimation { showArchived.toggle() }
        } label: {
            Image(systemName: showArchived ? "archivebox.fill" : "archivebox")
                .font(.system(size: 14))
                .foregroundStyle(showArchived ? NimbalystColors.primary : .secondary)
        }
    }

    // MARK: - Session List Content

    @ViewBuilder
    private var sessionListRows: some View {
        // Phase filter - only show when sessions have phase data
        if model.facets.hasPhaseData {
            Picker("Filter", selection: $phaseFilter) {
                ForEach(PhaseFilter.allCases, id: \.self) { filter in
                    Text(filter.rawValue).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
        }

        // Scrolling back up past the window's head re-attaches the page that was
        // dropped, so trimming is invisible rather than a dead end at the top.
        if model.canLoadPrevious {
            pageLoaderRow { model.loadPreviousPage() }
        }

        // Meta-agent groups always render first, in their own section (mirrors desktop,
        // which places the "Meta Agent" group at the very top). Gated on the alpha flag.
        if metaAgentEnabled && !model.metaAgentItems.isEmpty {
            Section("Meta Agent") {
                ForEach(model.metaAgentItems) { item in
                    metaAgentGroupView(item)
                }
            }
        }

        // All items interleaved by time period
        ForEach(model.sections) { periodGroup in
            Section(periodGroup.period.rawValue) {
                ForEach(periodGroup.items) { item in
                    sessionListItemView(item)
                }
            }
        }

        if model.hasMore || model.exceptionsHaveMore {
            pageLoaderRow {
                model.loadNextPage(anchorId: model.sections.last?.items.last?.id)
                // The running/queued/pinned lane pages alongside the timeline it is
                // merged into, so an overflowing lane is reachable by scrolling rather
                // than silently capped.
                model.loadMoreExceptions()
            }
        }

        if isSearching && !model.isHistoryComplete && !model.isEmpty {
            searchCoverageRow
        }
    }

    private var isSearching: Bool { !searchText.isEmpty }

    /// Cached results are shown immediately, but until sync coverage is known complete
    /// they cannot be presented as the whole answer -- including when they are empty.
    private var searchCoverageRow: some View {
        HStack(spacing: 6) {
            if coverage.hasError || appState.indexLoadState == .failed {
                Image(systemName: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90")
            } else if coverage.compatibility != .legacyServer {
                ProgressView().controlSize(.small)
            }
            Text(incompleteHistoryDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .listRowSeparator(.hidden)
    }

    /// Pulls an adjacent page into the window as it scrolls into view.
    private func pageLoaderRow(_ load: @escaping () -> Void) -> some View {
        HStack {
            Spacer()
            ProgressView().controlSize(.small)
            Spacer()
        }
        .listRowSeparator(.hidden)
        .onAppear(perform: load)
    }

    private var sessionListContent: some View {
        ScrollViewReader { proxy in
            List(selection: $selection) {
                sessionListRows
            }
            .listStyle(.plain)
            // Holding the reader's place when the window trims its head is the only
            // reason a page leaving memory is invisible.
            .onChange(of: model.scrollAnchor) { _, anchor in
                guard let anchor else { return }
                proxy.scrollTo(anchor, anchor: .top)
                model.clearScrollAnchor()
            }
        }
        .searchable(text: $searchText, prompt: "Search sessions")
        .refreshable {
            model.refresh()
            appState.requestSync()
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        .overlay {
            if model.isEmpty && !historyComplete && (coverage.hasError || appState.indexLoadState == .failed || coverage.compatibility == .legacyServer) && model.state == .loaded {
                VStack(spacing: 12) {
                    Image(systemName: coverage.hasError || appState.indexLoadState == .failed ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90" : "clock.arrow.circlepath").font(.largeTitle)
                    Text("History may be incomplete")
                    Text(incompleteHistoryDescription).font(.caption)
                }
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding()
            } else if model.isEmpty {
                // An empty list during history fill is still loading. An empty
                // search result is not: the placeholder's own copy says the search
                // is still being checked, and a spinner would run for the whole
                // bootstrap.
                IndexListPlaceholder(
                    noun: "Sessions", symbol: "bubble.left.and.bubble.right",
                    emptyDescription: emptyDescription,
                    observationState: model.state == .loaded && !model.isHistoryComplete && !isSearching ? .loading : model.state
                )
            }
        }
    }

    private var incompleteHistoryDescription: String {
        if coverage.hasError || appState.indexLoadState == .failed {
            return "Couldn’t check available sessions. Pull down to retry."
        }
        if coverage.compatibility == .legacyServer {
            return "Showing cached history. Full history sync needs a server update."
        }
        return "Still syncing available sessions"
    }

    /// An empty search result is only definitive once history coverage is complete.
    private var emptyDescription: String {
        if isSearching && !model.isHistoryComplete {
            return "Still checking available cloud sessions for matches."
        }
        if isSearching {
            return "No sessions match this search."
        }
        return "Start a session in Nimbalyst on your computer, or tap + to create one."
    }

    // MARK: - Creation Menu

    private var creationMenu: some View {
        Menu {
            Button {
                createAndNavigateToSession()
            } label: {
                Label("New Session", systemImage: "bubble.left")
            }

            Button {
                createWorktree()
            } label: {
                Label("New Worktree", systemImage: "arrow.triangle.branch")
            }

            Button {
                createWorkstream()
            } label: {
                Label("New Workstream", systemImage: "folder.badge.plus")
            }

            if metaAgentEnabled {
                Button {
                    createMetaAgent()
                } label: {
                    Label("New Meta Agent", systemImage: "point.3.connected.trianglepath.dotted")
                }
            }

            #if os(iOS)
            if let voice = appState.voiceAgent,
               VoiceSessionListActionPolicy.showsStartVoiceAgent(
                   selectedTabIsSessions: selectedTab == .sessions,
                   voiceIsDisconnected: voice.state == .disconnected
               ) {
                Button {
                    appState.configureVoiceAgent(forProject: project.id)
                    voice.start(scope: .project)
                } label: {
                    Label("Start Voice Agent", systemImage: "mic.fill")
                }
            }
            #endif

            if !appState.availableModels.isEmpty {
                Divider()

                Button {
                    showModelPicker = true
                } label: {
                    Label("Model: \(selectedModelDisplayName)", systemImage: "cpu")
                }
            }
        } label: {
            if isCreatingSession {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: "plus")
            }
        }
        .disabled(isCreatingSession)
        .onReceive(NotificationCenter.default.publisher(for: .init("MetaAgentEnabledSynced"))) { _ in
            metaAgentEnabled = FeaturePreferences.metaAgentEnabled
        }
    }

    // MARK: - Session List Item View

    @ViewBuilder
    private func sessionListItemView(_ item: SessionListItem) -> some View {
        switch item {
        case .group(let pageItem):
            WorkstreamSection(
                item: pageItem,
                children: model.children[pageItem.group.key] ?? [],
                hasMoreChildren: model.childrenHaveMore.contains(pageItem.group.key),
                isExpanded: groupExpansionBinding(for: pageItem.group.key),
                voiceFocusedSessionId: voiceFocusedSessionId,
                onLoadMoreChildren: { model.loadMoreChildren(groupKey: pageItem.group.key) }
            )
            .contextMenu {
                groupContextMenu(for: pageItem)
            }
        case .session(let row):
            NavigationLink(value: WorkspaceSelection.session(row.id)) {
                SessionRow(
                    session: row,
                    voiceFocusedSessionId: voiceFocusedSessionId
                )
            }
            .contextMenu {
                standaloneContextMenu(for: row)
            }
        }
    }

    // MARK: - Meta Agent Group View

    @ViewBuilder
    private func metaAgentGroupView(_ item: SessionListPageItem) -> some View {
        // The group context menu is passed INTO the view so it can be attached to the
        // header row only. `MetaAgentGroupView` emits the header and each child as
        // separate List rows, so a call-site `.contextMenu` would leak onto the children.
        MetaAgentGroupView(
            item: item,
            children: model.children[item.group.key] ?? [],
            hasMoreChildren: model.childrenHaveMore.contains(item.group.key),
            isExpanded: metaExpansionBinding(for: item),
            voiceFocusedSessionId: voiceFocusedSessionId,
            onLoadMoreChildren: { model.loadMoreChildren(groupKey: item.group.key) },
            headerContextMenu: { metaAgentGroupContextMenu(for: item) }
        )
    }

    // MARK: - Context Menus

    @ViewBuilder
    private func metaAgentGroupContextMenu(for item: SessionListPageItem) -> some View {
        Button {
            archiveGroup(item, archive: !item.parent.isArchived)
        } label: {
            Label(
                item.parent.isArchived ? "Unarchive Group" : "Archive Group",
                systemImage: item.parent.isArchived ? "arrow.uturn.backward" : "archivebox"
            )
        }

        Button(role: .destructive) {
            deleteGroup(item)
        } label: {
            Label("Delete Group", systemImage: "trash")
        }
    }

    @ViewBuilder
    private func standaloneContextMenu(for row: SessionListRow) -> some View {
        Button {
            convertToWorkstream(session: row)
        } label: {
            Label("Start Workstream", systemImage: "folder.badge.plus")
        }

        if !model.workstreamParents.isEmpty {
            Menu("Move to Workstream") {
                if model.canLoadPreviousWorkstreams {
                    Button("Newer Workstreams") { model.loadNewerWorkstreams() }
                }
                ForEach(model.workstreamParents) { workstream in
                    Button(workstream.titleDecrypted ?? "Workstream") {
                        reparentSession(sessionId: row.id, newParentId: workstream.id)
                    }
                }
                if model.workstreamParentsHaveMore {
                    Button("Older Workstreams") { model.loadOlderWorkstreams() }
                }
            }
        }

        Divider()

        Button {
            archiveSession(row, archive: !row.isArchived)
        } label: {
            Label(
                row.isArchived ? "Unarchive" : "Archive",
                systemImage: row.isArchived ? "arrow.uturn.backward" : "archivebox"
            )
        }

        Button(role: .destructive) {
            deleteSession(row)
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    @ViewBuilder
    private func groupContextMenu(for item: SessionListPageItem) -> some View {
        Button {
            createChildSession(parentId: item.parent.id, groupKey: item.group.key)
        } label: {
            Label("Add Session", systemImage: "plus.bubble")
        }

        Divider()

        Button {
            archiveSession(item.parent, archive: !item.parent.isArchived)
        } label: {
            Label(
                item.parent.isArchived ? "Unarchive" : "Archive",
                systemImage: item.parent.isArchived ? "arrow.uturn.backward" : "archivebox"
            )
        }

        Button(role: .destructive) {
            deleteSession(item.parent)
        } label: {
            Label("Delete", systemImage: "trash")
        }
    }

    // MARK: - Connection Indicator

    private var isDesktopConnected: Bool {
        if appState.screenshotMode { return true }
        return appState.syncManager?.connectedDevices.contains(where: { $0.type == "desktop" }) ?? false
    }

    private var connectionIndicator: some View {
        HStack(spacing: 4) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 14))
                .foregroundStyle(appState.isConnected ? .primary : .secondary)
            Circle()
                .fill(isDesktopConnected ? Color.green : (appState.isConnected ? Color.orange : Color.gray))
                .frame(width: 8, height: 8)
        }
    }

    // MARK: - Model Selector

    private var selectedModelDisplayName: String {
        guard let modelId = selectedModelId else { return "Default" }
        if let model = appState.availableModels.first(where: { $0.id == modelId }) {
            return model.name
        }
        // Fallback: strip provider prefix
        let parts = modelId.split(separator: ":", maxSplits: 1)
        return parts.count > 1 ? String(parts[1]) : modelId
    }

    private func resolveDefaultModel() {
        if selectedModelId == nil {
            selectedModelId = ModelPreferences.resolveModel(
                available: appState.availableModels,
                desktopDefault: appState.desktopDefaultModel
            )
        }
    }

    // MARK: - Expand/Collapse Persistence

    private var expandedStateKey: String {
        "expandedSessionGroups_\(project.id)"
    }

    /// Meta-agent collapse is persisted by session id (see `MetaAgentExpansion`); the
    /// window addresses groups by key, so translate at the boundary.
    private var collapsedMetaAgentKeys: Set<String> {
        Set(collapsedMetaAgents.map { "meta:\($0)" })
    }

    private func loadExpandedState() {
        if let data = UserDefaults.standard.data(forKey: expandedStateKey),
           let keys = try? JSONDecoder().decode(Set<String>.self, from: data) {
            expandedGroupKeys = keys
        } else {
            expandedGroupKeys = []
        }
        collapsedMetaAgents = MetaAgentExpansion(projectId: project.id).collapsedIds()
    }

    private func saveExpandedState() {
        if let data = try? JSONEncoder().encode(expandedGroupKeys) {
            UserDefaults.standard.set(data, forKey: expandedStateKey)
        }
    }

    private func groupExpansionBinding(for groupKey: String) -> Binding<Bool> {
        Binding(
            get: { model.isExpanded(groupKey) },
            set: { expanded in
                if expanded {
                    expandedGroupKeys.insert(groupKey)
                } else {
                    expandedGroupKeys.remove(groupKey)
                }
                saveExpandedState()
                model.setPersistedExpansion(expandedKeys: expandedGroupKeys, collapsedKeys: collapsedMetaAgentKeys)
                model.setExpanded(expanded, groupKey: groupKey)
            }
        )
    }

    private func metaExpansionBinding(for item: SessionListPageItem) -> Binding<Bool> {
        Binding(
            get: { model.isExpanded(item.group.key) },
            set: { expanded in
                if expanded {
                    collapsedMetaAgents.remove(item.parent.id)
                } else {
                    collapsedMetaAgents.insert(item.parent.id)
                }
                MetaAgentExpansion(projectId: project.id).setCollapsedIds(collapsedMetaAgents)
                model.setPersistedExpansion(expandedKeys: expandedGroupKeys, collapsedKeys: collapsedMetaAgentKeys)
                model.setExpanded(expanded, groupKey: item.group.key)
            }
        )
    }

    // MARK: - Actions

    private func deleteSession(_ row: SessionListRow) {
        guard let db = appState.databaseManager else { return }
        do {
            try db.deleteSession(row.id)
            if selection == .session(row.id) { selection = nil }
            try db.refreshSessionCount(forProject: project.id)
        } catch {
            print("Failed to delete session: \(error)")
        }
    }

    /// Create a new standalone session.
    private func createAndNavigateToSession() {
        guard let sync = appState.syncManager else { return }
        isCreatingSession = true
        do {
            try sync.createSession(
                projectId: project.id,
                initialPrompt: nil,
                provider: ModelPreferences.providerFromModelId(selectedModelId),
                model: selectedModelId,
                targetDeviceId: hostDeviceId
            )
            AnalyticsManager.shared.capture("mobile_session_created", properties: [
                "model": selectedModelId ?? "default"
            ])
        } catch {
            print("Failed to create session: \(error)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            isCreatingSession = false
        }
    }

    /// Create a new workstream parent session.
    private func createWorkstream() {
        guard let sync = appState.syncManager else { return }
        isCreatingSession = true
        do {
            try sync.createSession(
                projectId: project.id,
                initialPrompt: nil,
                sessionType: "workstream",
                provider: ModelPreferences.providerFromModelId(selectedModelId),
                model: selectedModelId,
                targetDeviceId: hostDeviceId
            )
            AnalyticsManager.shared.capture("mobile_workstream_created")
        } catch {
            print("Failed to create workstream: \(error)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            isCreatingSession = false
        }
    }

    /// Create a new meta-agent session (can spawn and orchestrate sub-agents).
    private func createMetaAgent() {
        guard let sync = appState.syncManager else { return }
        isCreatingSession = true
        do {
            try sync.createSession(
                projectId: project.id,
                initialPrompt: nil,
                provider: ModelPreferences.providerFromModelId(selectedModelId),
                model: selectedModelId,
                agentRole: "meta-agent",
                targetDeviceId: hostDeviceId
            )
            AnalyticsManager.shared.capture("mobile_meta_agent_created", properties: [
                "model": selectedModelId ?? "default"
            ])
        } catch {
            print("Failed to create meta agent: \(error)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            isCreatingSession = false
        }
    }

    /// Create a child session within a workstream.
    private func createChildSession(parentId: String, groupKey: String) {
        guard let sync = appState.syncManager else { return }
        do {
            try sync.createSession(
                projectId: project.id,
                initialPrompt: nil,
                parentSessionId: parentId,
                provider: ModelPreferences.providerFromModelId(selectedModelId),
                model: selectedModelId,
                targetDeviceId: hostDeviceId
            )
            AnalyticsManager.shared.capture("mobile_child_session_created")
            // Auto-expand the parent workstream
            groupExpansionBinding(for: groupKey).wrappedValue = true
        } catch {
            print("Failed to create child session: \(error)")
        }
    }

    /// Move a standalone session into a workstream.
    private func reparentSession(sessionId: String, newParentId: String) {
        guard let sync = appState.syncManager else { return }
        do {
            try sync.updateSessionParent(sessionId: sessionId, parentSessionId: newParentId)
            // Auto-expand the target workstream
            groupExpansionBinding(for: "ws:\(newParentId)").wrappedValue = true
        } catch {
            print("Failed to reparent session: \(error)")
        }
    }

    /// Convert a standalone session into a workstream.
    /// Creates a workstream parent and reparents the session under it.
    /// Since session creation is async (via WebSocket), we watch for the new workstream
    /// to appear and then reparent the original session under it.
    private func convertToWorkstream(session: SessionListRow) {
        guard let sync = appState.syncManager, let db = appState.databaseManager else { return }
        do {
            // Snapshot current workstream IDs so we can detect the new one. This is a
            // bounded query rather than a scan of the loaded list, so it works the same
            // whether or not the existing workstreams are inside the current window.
            let existingIds = Set(try db.workstreamParents(projectId: project.id, limit: 200).map(\.id))

            try sync.createSession(
                projectId: project.id,
                initialPrompt: nil,
                sessionType: "workstream",
                targetDeviceId: hostDeviceId
            )
            AnalyticsManager.shared.capture("mobile_convert_to_workstream")

            // Watch for the new workstream to appear (created async by desktop),
            // then reparent the original session under it.
            // The task outlives the `do/catch` below, so it has to report its own
            // failures — an unhandled throw here would abandon the reparent with
            // the session silently left at the top level.
            let projectId = project.id
            Task {
                let sessionId = session.id
                do {
                    for _ in 0..<20 { // Poll for up to ~10s
                        try await Task.sleep(nanoseconds: 500_000_000)
                        let created = try db.workstreamParents(projectId: projectId, limit: 200)
                            .first { !existingIds.contains($0.id) }
                        if let workstream = created {
                            try sync.updateSessionParent(sessionId: sessionId, parentSessionId: workstream.id)
                            await MainActor.run {
                                groupExpansionBinding(for: "ws:\(workstream.id)").wrappedValue = true
                            }
                            return
                        }
                    }
                } catch {
                    print("Failed to reparent session under new workstream: \(error)")
                }
            }
        } catch {
            print("Failed to convert to workstream: \(error)")
        }
    }

    /// Archive or unarchive a session.
    private func archiveSession(_ row: SessionListRow, archive: Bool) {
        guard let sync = appState.syncManager else { return }
        do {
            try sync.setSessionArchived(sessionId: row.id, isArchived: archive)
            if archive && !showArchived && selection == .session(row.id) { selection = nil }
            AnalyticsManager.shared.capture(archive ? "mobile_session_archived" : "mobile_session_unarchived")
        } catch {
            print("Failed to \(archive ? "archive" : "unarchive") session: \(error)")
        }
    }

    /// Archive (or unarchive) a whole group. Membership comes from SQL, so it covers
    /// every cached member rather than the page of children that happens to be loaded.
    private func archiveGroup(_ item: SessionListPageItem, archive: Bool) {
        guard let sync = appState.syncManager, let db = appState.databaseManager else { return }
        do {
            let sessionIds = try db.sessionListGroupMemberIds(
                filter: .locating(projectId: project.id, metaAgentEnabled: metaAgentEnabled),
                groupKey: item.group.key
            )
            for sessionId in sessionIds {
                try sync.setSessionArchived(sessionId: sessionId, isArchived: archive)
                if archive && !showArchived && selection == .session(sessionId) { selection = nil }
            }
            AnalyticsManager.shared.capture(archive ? "mobile_session_archived" : "mobile_session_unarchived")
        } catch {
            print("Failed to \(archive ? "archive" : "unarchive") group: \(error)")
        }
    }

    /// Delete a whole group: the header session and everything under it.
    private func deleteGroup(_ item: SessionListPageItem) {
        guard let db = appState.databaseManager else { return }
        do {
            let sessionIds = try db.sessionListGroupMemberIds(
                filter: .locating(projectId: project.id, metaAgentEnabled: metaAgentEnabled),
                groupKey: item.group.key
            )
            for sessionId in sessionIds {
                try db.deleteSession(sessionId)
                if selection == .session(sessionId) { selection = nil }
            }
            try db.refreshSessionCount(forProject: project.id)
        } catch {
            print("Failed to delete group: \(error)")
        }
    }

    /// Request the desktop to create a new git worktree.
    private func createWorktree() {
        guard let sync = appState.syncManager else { return }
        isCreatingSession = true
        do {
            try sync.createWorktree(projectId: project.id)
            AnalyticsManager.shared.capture("mobile_worktree_created")
        } catch {
            print("Failed to create worktree: \(error)")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            isCreatingSession = false
        }
    }
}
