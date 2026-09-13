import Foundation
import Combine
import GRDB

/// Owns the sidebar's bounded window: which slice of history is materialized, which
/// groups are expanded, and the grouped sections the list renders.
///
/// Two properties matter for performance and are easy to lose in a refactor:
///
/// 1. **Sections are built once per snapshot**, not recomputed while SwiftUI evaluates
///    `body`. The previous implementation recomputed hierarchy grouping inside computed
///    properties, so every row update re-grouped the entire project.
/// 2. **The window never grows.** Paging further into history advances `startCursor`
///    and drops the pages that scrolled off the top, so `materializedLimit` is a
///    ceiling rather than a running total.
@MainActor
final class SessionListWindowModel: ObservableObject {
    typealias ProjectionRefresh = @Sendable (DatabaseManager, String, Bool) async throws -> Void
    private let refreshProjection: ProjectionRefresh

    init(refreshProjection: @escaping ProjectionRefresh = { (database: DatabaseManager, projectId: String, metaEnabled: Bool) async throws -> Void in
        _ = try await Task.detached(priority: .utility) {
            try database.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: metaEnabled)
        }.value
    }) {
        self.refreshProjection = refreshProjection
    }

    // Budgets. Starting points from the plan, not user settings — tune from
    // measurements, but never let them become a function of total history.
    nonisolated static let pageSize = 100
    nonisolated static let maxMaterializedItems = 300
    nonisolated static let childPageSize = 50
    nonisolated static let maxMaterializedChildren = 200
    nonisolated static let exceptionPageSize = 50
    /// Expanded groups each cost one child query per database change, so the set of
    /// them is capped and evicted least-recently-opened first. Groups scrolled far off
    /// screen do not keep paying.
    nonisolated static let maxExpandedGroups = 12

    /// Meta-agent groups, which the list pins to their own section above the timeline.
    @Published private(set) var metaAgentItems: [SessionListPageItem] = []
    /// Everything else, grouped by time period.
    @Published private(set) var sections: [GroupedSessionItems] = []
    @Published private(set) var children: [String: [SessionListRow]] = [:]
    @Published private(set) var childrenHaveMore: Set<String> = []
    @Published private(set) var workstreamParents: [SessionListRow] = []
    @Published private(set) var workstreamParentsHaveMore = false
    private var workstreamParentCursor: SessionListChildCursor?
    private var previousWorkstreamCursors: [SessionListChildCursor?] = []
    @Published private(set) var facets = SessionListFacets(hasArchived: false, hasPhaseData: false)
    @Published private(set) var state: IndexLoadState = .loading
    @Published private(set) var isEmpty = true
    @Published private(set) var hasMore = false
    /// More running / queued / pinned rows exist than the exception lane is showing.
    @Published private(set) var exceptionsHaveMore = false
    /// False while sync coverage is unknown or incomplete: results (including an empty
    /// result) cannot be reported as definitive.
    @Published var isHistoryComplete = false
    /// Set after the window trims its head so the list can hold the reader's place.
    @Published private(set) var scrollAnchor: String?

    private var database: DatabaseManager?
    private var filter: SessionListFilter?
    private var startCursor: SessionListCursor?
    /// Cursors of the pages dropped off the top, newest last, so scrolling back up
    /// restores exactly the window that was there before.
    private var trimmedCursors: [SessionListCursor?] = []
    private var materializedLimit = SessionListWindowModel.pageSize
    private var expandedGroups: [String: SessionListChildWindow] = [:]
    /// Expansion order, oldest first, for evicting past `maxExpandedGroups`.
    private var expansionOrder: [String] = []
    private var exceptionWindow = SessionListExceptionWindow(limit: SessionListWindowModel.exceptionPageSize)
    private var focusSessionId: String?
    /// Persisted expansion, applied lazily as groups enter the window so restoring it
    /// never means querying children for groups the user cannot see.
    private var persistedExpandedKeys: Set<String> = []
    private var persistedCollapsedKeys: Set<String> = []
    private var restoredExpansionKeys: Set<String> = []
    private var cancellable: AnyDatabaseCancellable?
    private var searchDebounce: Task<Void, Never>?
    /// Last item ids in window order, used to compute the new start cursor when the
    /// head is trimmed.
    private var windowItems: [SessionListPageItem] = []
    private var renderedItemCount = 0
    private var nextExceptionCursor: SessionListCursor?
    private var projectionRefresh: Task<Void, Never>?
    private var projectionRefreshRequested = false
    private var projectionGeneration = 0
    private var observationGeneration = 0

    // MARK: - Lifecycle

    func start(database: DatabaseManager?, filter: SessionListFilter) {
        stop()
        if self.database !== database || self.filter?.projectId != filter.projectId {
            expandedGroups = [:]
            expansionOrder = []
            restoredExpansionKeys = []
            focusSessionId = nil
            windowItems = []
            metaAgentItems = []
            sections = []
            children = [:]
            workstreamParents = []
            isEmpty = true
        }
        self.database = database
        self.filter = filter
        resetWindow()
        // First run for a project builds the projection; after that this is a no-op
        // unless something changed.
        scheduleProjectionRefresh()
        restartObservation()
    }

    /// Apply a new filter. Search text is debounced so typing does not restart the
    /// observation on every keystroke.
    func setFilter(_ newFilter: SessionListFilter) {
        guard newFilter != filter else { return }
        if newFilter.projectId != filter?.projectId {
            start(database: database, filter: newFilter)
            return
        }
        let onlySearchChanged = filter.map { current in
            var probe = current
            probe.searchText = newFilter.searchText
            return probe == newFilter
        } ?? false

        filter = newFilter
        resetWindow()

        searchDebounce?.cancel()
        guard onlySearchChanged else {
            restartObservation()
            return
        }
        searchDebounce = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled else { return }
            self?.restartObservation()
        }
    }

    /// Keep a deep-linked session's group in the window even when it is outside the
    /// current page (notification, voice action, or restored selection).
    func setFocus(sessionId: String?) {
        guard focusSessionId != sessionId else { return }
        focusSessionId = sessionId
        restartObservation()
    }

    func refresh() {
        resetWindow()
        restartObservation()
    }

    func stop() {
        projectionGeneration &+= 1
        observationGeneration &+= 1
        projectionRefresh?.cancel()
        projectionRefresh = nil
        projectionRefreshRequested = false
        searchDebounce?.cancel()
        cancellable?.cancel()
        cancellable = nil
    }

    // MARK: - Paging

    /// Load the next page of older history. Once the window is full this drops the
    /// oldest-loaded page from the top rather than widening the query.
    func loadNextPage(anchorId: String?) {
        guard hasMore, database != nil else { return }
        if materializedLimit + Self.pageSize <= Self.maxMaterializedItems {
            materializedLimit += Self.pageSize
        } else {
            guard windowItems.count > Self.pageSize else { return }
            let boundary = windowItems[Self.pageSize - 1].group
            trimmedCursors.append(startCursor)
            startCursor = SessionListCursor(orderTimestamp: boundary.orderTimestamp, groupKey: boundary.key)
            scrollAnchor = anchorId
        }
        restartObservation()
    }

    /// Re-attach the page that was trimmed off the top when the reader scrolls back up.
    func loadPreviousPage() {
        guard let previous = trimmedCursors.popLast() else { return }
        startCursor = previous
        scrollAnchor = windowItems.first?.rowIdentity
        restartObservation()
    }

    var canLoadPrevious: Bool { !trimmedCursors.isEmpty }

    /// Pull the next page of the running / queued / pinned lane. Same bounded-window
    /// rule as the main list: past the ceiling the lane advances its own start cursor.
    func loadMoreExceptions() {
        guard exceptionsHaveMore else { return }
        if exceptionWindow.limit + Self.exceptionPageSize <= Self.maxMaterializedItems {
            exceptionWindow.limit += Self.exceptionPageSize
        } else if let cursor = nextExceptionCursor {
            exceptionWindow.startCursor = cursor
        } else {
            return
        }
        restartObservation()
    }

    /// Display rows currently held in memory. Bounded by `maxMaterializedItems` plus
    /// the page exceptions and any focused row.
    var materializedItemCount: Int { renderedItemCount }

    /// Key of the newest row in the window, which moves forward once the head is trimmed.
    var firstItemKey: String? { windowItems.first?.group.key }

    func clearScrollAnchor() { scrollAnchor = nil }

    var canLoadPreviousWorkstreams: Bool { !previousWorkstreamCursors.isEmpty }

    func loadOlderWorkstreams() {
        guard workstreamParentsHaveMore, let last = workstreamParents.last else { return }
        previousWorkstreamCursors.append(workstreamParentCursor)
        workstreamParentCursor = SessionListChildCursor(updatedAt: last.updatedAt, id: last.id)
        restartObservation()
    }

    func loadNewerWorkstreams() {
        guard let previous = previousWorkstreamCursors.popLast() else { return }
        workstreamParentCursor = previous
        restartObservation()
    }

    // MARK: - Group expansion

    /// Seed persisted expansion. Workstream/worktree groups default to collapsed and
    /// remember what was opened; meta-agent groups default to expanded and remember
    /// what was closed (mirroring desktop) — hence two sets rather than one.
    func setPersistedExpansion(expandedKeys: Set<String>, collapsedKeys: Set<String>) {
        persistedExpandedKeys = expandedKeys
        persistedCollapsedKeys = collapsedKeys
    }

    func isExpanded(_ groupKey: String) -> Bool {
        expandedGroups[groupKey] != nil
    }

    func setExpanded(_ expanded: Bool, groupKey: String) {
        if expanded {
            guard expandedGroups[groupKey] == nil else { return }
            expandedGroups[groupKey] = SessionListChildWindow(limit: Self.childPageSize)
            expansionOrder.append(groupKey)
            evictExcessExpansions()
        } else {
            guard expandedGroups.removeValue(forKey: groupKey) != nil else { return }
            expansionOrder.removeAll { $0 == groupKey }
        }
        restartObservation()
    }

    /// Drop the least-recently-opened groups so the per-change child query count stays
    /// bounded no matter how many groups the user has opened while scrolling.
    private func evictExcessExpansions() {
        while expansionOrder.count > Self.maxExpandedGroups {
            let evicted = expansionOrder.removeFirst()
            expandedGroups.removeValue(forKey: evicted)
        }
    }

    /// Next page of children inside one expanded group, with the same bounded-window
    /// rule as the top level.
    func loadMoreChildren(groupKey: String) {
        guard var window = expandedGroups[groupKey], childrenHaveMore.contains(groupKey) else { return }
        if window.limit + Self.childPageSize <= Self.maxMaterializedChildren {
            window.limit += Self.childPageSize
        } else {
            guard let rows = children[groupKey], rows.count > Self.childPageSize else { return }
            let boundary = rows[Self.childPageSize - 1]
            window.startCursor = SessionListChildCursor(updatedAt: boundary.updatedAt, id: boundary.id)
        }
        expandedGroups[groupKey] = window
        restartObservation()
    }

    // MARK: - Observation

    private func resetWindow() {
        startCursor = nil
        trimmedCursors = []
        workstreamParentCursor = nil
        previousWorkstreamCursors = []
        materializedLimit = Self.pageSize
        exceptionWindow = SessionListExceptionWindow(limit: Self.exceptionPageSize)
        expandedGroups = expandedGroups.mapValues { _ in SessionListChildWindow(limit: Self.childPageSize) }
    }

    private var request: SessionListWindowRequest? {
        guard let filter else { return nil }
        return SessionListWindowRequest(
            filter: filter,
            startCursor: startCursor,
            materializedLimit: materializedLimit,
            expandedGroups: expandedGroups,
            focusSessionId: focusSessionId,
            exceptionWindow: exceptionWindow,
            workstreamParentCursor: workstreamParentCursor
        )
    }

    private func restartObservation() {
        observationGeneration &+= 1
        let generation = observationGeneration
        cancellable?.cancel()
        guard let database, let request else {
            cancellable = nil
            return
        }
        state = .loading
        cancellable = database.sessionListWindowObservation(request).start(
            in: database.writer,
            onError: { [weak self] error in
                guard let self, self.observationGeneration == generation else { return }
                self.state = .failed
                print("Session list window error: \(error)")
            },
            onChange: { [weak self] snapshot in
                guard let self, self.observationGeneration == generation else { return }
                self.apply(snapshot)
            }
        )
    }

    /// Build the rendered sections exactly once per database change. Deliberately not
    /// wrapped in `withAnimation`: a context-meter or read-marker update must not
    /// animate the whole list.
    private func apply(_ snapshot: SessionListWindowSnapshot) {
        var merged = snapshot.items
        merged.append(contentsOf: snapshot.exceptions)
        if let focus = snapshot.focus { merged.append(focus) }
        merged.sort { lhs, rhs in
            lhs.group.orderTimestamp == rhs.group.orderTimestamp
                ? lhs.group.key > rhs.group.key
                : lhs.group.orderTimestamp > rhs.group.orderTimestamp
        }

        // Exceptions and focused rows must not move the main history cursor.
        windowItems = snapshot.items
        renderedItemCount = merged.count
        metaAgentItems = merged.filter { $0.group.kind == .metaAgent }
        sections = Self.sections(for: merged.filter { $0.group.kind != .metaAgent })
        children = snapshot.children
        childrenHaveMore = snapshot.childrenHaveMore
        workstreamParents = snapshot.workstreamParents
        workstreamParentsHaveMore = snapshot.workstreamParentsHaveMore
        facets = snapshot.facets
        hasMore = snapshot.hasMore
        exceptionsHaveMore = snapshot.exceptionsHaveMore
        nextExceptionCursor = snapshot.nextExceptionCursor
        isEmpty = snapshot.isEmpty
        state = .loaded

        // The projection is maintained by triggers plus this refresh. A non-zero
        // pending count means some session writes have not been folded in yet, so the
        // window is briefly stale; folding them in re-fires the observation.
        // Also refresh when this filter *could* be served by the projection but was
        // not -- a first run, or a meta-agent gate flip that invalidated the stored
        // grouping. Once the rebuild lands, `usedProjection` is true and this stops.
        let projectableButUnused = !snapshot.usedProjection
            && filter.map { $0.likePattern == nil && !$0.includeArchived } == true
        if snapshot.pendingProjectionUpdates > 0 || projectableButUnused {
            scheduleProjectionRefresh()
        }

        applyPersistedExpansion(to: merged)
    }

    /// Fold pending session writes into the group projection off the main actor. The
    /// write re-fires the observation, so the refreshed window arrives on its own.
    private func scheduleProjectionRefresh() {
        guard database != nil, filter != nil else { return }
        // Remember requests made while a refresh is finishing. The task clears its
        // handle on the same actor as this flag, leaving no lost-wakeup window.
        projectionRefreshRequested = true
        guard projectionRefresh == nil else { return }
        let generation = projectionGeneration
        projectionRefresh = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.projectionGeneration == generation { self.projectionRefresh = nil }
            }
            while self.projectionRefreshRequested {
                guard !Task.isCancelled, self.projectionGeneration == generation else { return }
                self.projectionRefreshRequested = false
                do {
                    try await Task.sleep(for: .milliseconds(50))
                    guard !Task.isCancelled, self.projectionGeneration == generation,
                          let database = self.database, let filter = self.filter else { return }
                    try await self.refreshProjection(database, filter.projectId, filter.metaAgentEnabled)
                } catch {
                    guard self.projectionGeneration == generation else { return }
                    self.projectionRefreshRequested = false
                    if !Task.isCancelled {
                        self.state = .failed
                        print("Session list projection refresh failed: \(error)")
                    }
                    return
                }
            }
        }
    }

    /// Open the groups the user had open last time, but only once they are actually in
    /// the window. Re-runs the observation at most once per newly-visible group set.
    private func applyPersistedExpansion(to items: [SessionListPageItem]) {
        var added = false
        for item in items where item.group.childCount > 0 && expandedGroups[item.group.key] == nil {
            guard restoredExpansionKeys.insert(item.group.key).inserted else { continue }
            let shouldExpand = item.group.kind == .metaAgent
                ? !persistedCollapsedKeys.contains(item.group.key)
                : persistedExpandedKeys.contains(item.group.key)
            if shouldExpand {
                expandedGroups[item.group.key] = SessionListChildWindow(limit: Self.childPageSize)
                expansionOrder.append(item.group.key)
                added = true
            }
        }
        if added {
            evictExcessExpansions()
            restartObservation()
        }
    }

    /// Interleave standalone rows and group headers into time-period sections, in one
    /// pass over the window.
    nonisolated static func sections(for items: [SessionListPageItem]) -> [GroupedSessionItems] {
        var byPeriod: [TimePeriod: [SessionListItem]] = [:]
        for item in items {
            let listItem: SessionListItem = item.group.kind == .standalone
                ? .session(item.parent)
                : .group(item)
            byPeriod[TimePeriod.classify(epochMs: item.group.orderTimestamp), default: []].append(listItem)
        }
        return TimePeriod.allCases.compactMap { period in
            guard let periodItems = byPeriod[period], !periodItems.isEmpty else { return nil }
            return GroupedSessionItems(period: period, items: periodItems)
        }
    }
}
