import Foundation
import GRDB

/// The bounded slice of one expanded group's children that is currently on screen.
/// Same shape as the top-level window: a keyset start and a constant ceiling, so a
/// workstream with 5,000 children costs the same as one with 50.
public struct SessionListChildWindow: Hashable, Sendable {
    public var startCursor: SessionListChildCursor?
    public var limit: Int

    public init(startCursor: SessionListChildCursor? = nil, limit: Int) {
        self.startCursor = startCursor
        self.limit = limit
    }
}

/// The bounded slice of the running / queued / pinned lane that is currently on
/// screen. Separate from the main window because these rows can be anywhere in
/// history, so they are found by attention state rather than by recency.
public struct SessionListExceptionWindow: Hashable, Sendable {
    public var startCursor: SessionListCursor?
    public var limit: Int

    public init(startCursor: SessionListCursor? = nil, limit: Int) {
        self.startCursor = startCursor
        self.limit = limit
    }
}

/// What the sidebar currently needs from the database.
///
/// Every field here is bounded. `materializedLimit` is a constant ceiling, not a
/// running total: paging further into history advances `startCursor` and drops the
/// pages that scrolled off the top, so the window never grows into "SELECT everything
/// I have scrolled past".
public struct SessionListWindowRequest: Hashable, Sendable {
    public var filter: SessionListFilter
    /// Exclusive upper bound of the window. `nil` means "start at the newest row".
    public var startCursor: SessionListCursor?
    /// Hard ceiling on how many display rows are held in memory.
    public var materializedLimit: Int
    /// Expanded groups and the bounded slice of children each currently shows.
    public var expandedGroups: [String: SessionListChildWindow]
    /// A session the user navigated to (notification, voice action, deep link) whose
    /// group must be present even when it falls outside the window.
    public var focusSessionId: String?
    /// The exception lane (running / queued / pinned) is paged in its own right: it has
    /// its own keyset start and ceiling, so a user with more than one page of running
    /// sessions can reach all of them instead of losing the overflow to a hard cap.
    public var exceptionWindow: SessionListExceptionWindow
    public var workstreamParentCursor: SessionListChildCursor?
    public var workstreamParentLimit: Int

    public init(
        filter: SessionListFilter,
        startCursor: SessionListCursor? = nil,
        materializedLimit: Int = 100,
        expandedGroups: [String: SessionListChildWindow] = [:],
        focusSessionId: String? = nil,
        exceptionWindow: SessionListExceptionWindow = SessionListExceptionWindow(limit: 50),
        workstreamParentLimit: Int = 100,
        workstreamParentCursor: SessionListChildCursor? = nil
    ) {
        self.filter = filter
        self.startCursor = startCursor
        self.materializedLimit = materializedLimit
        self.expandedGroups = expandedGroups
        self.focusSessionId = focusSessionId
        self.exceptionWindow = exceptionWindow
        self.workstreamParentLimit = workstreamParentLimit
        self.workstreamParentCursor = workstreamParentCursor
    }
}

/// One atomic read of everything the sidebar draws.
public struct SessionListWindowSnapshot: Sendable {
    public var items: [SessionListPageItem]
    /// Running / waiting / pinned rows from outside the window, merged into the same
    /// time sections so they stay reachable without adding a new UI surface.
    public var exceptions: [SessionListPageItem]
    /// The deep-linked session's group, if it is not already in `items`.
    public var focus: SessionListPageItem?
    public var children: [String: [SessionListRow]]
    public var childrenHaveMore: Set<String>
    public var workstreamParents: [SessionListRow]
    public var workstreamParentsHaveMore: Bool
    public var facets: SessionListFacets
    public var hasMore: Bool
    public var exceptionsHaveMore: Bool
    /// Cursor to hand back when the user scrolls further into history.
    public var nextCursor: SessionListCursor?
    /// Cursor for the next page of the exception lane.
    public var nextExceptionCursor: SessionListCursor?
    /// Session changes not yet folded into the group projection. Non-zero means the
    /// window is briefly stale and a refresh should be scheduled.
    public var pendingProjectionUpdates: Int
    /// Whether this snapshot came from the projection or the live fallback query.
    public var usedProjection: Bool

    public var isEmpty: Bool { items.isEmpty && exceptions.isEmpty && focus == nil }
}

public extension DatabaseManager {
    /// Read the whole sidebar window in one transaction, so the page, its exceptions,
    /// expanded children and facets can never disagree with each other.
    func sessionListWindow(_ request: SessionListWindowRequest) throws -> SessionListWindowSnapshot {
        try writer.read { db in try SessionListQueryRunner.window(db, request: request) }
    }

    /// A `ValueObservation` over the same window. GRDB re-runs it when the sessions
    /// table changes; the work per change is bounded by the window, not by history.
    func sessionListWindowObservation(
        _ request: SessionListWindowRequest
    ) -> ValueObservation<ValueReducers.Fetch<SessionListWindowSnapshot>> {
        ValueObservation.tracking { db in
            try SessionListQueryRunner.window(db, request: request)
        }
    }
}

extension SessionListQueryRunner {
    static func window(_ db: Database, request: SessionListWindowRequest) throws -> SessionListWindowSnapshot {
        let page = try page(
            db,
            filter: request.filter,
            after: request.startCursor,
            limit: request.materializedLimit
        )
        let exceptionPage = try exceptions(
            db,
            filter: request.filter,
            after: request.exceptionWindow.startCursor,
            limit: request.exceptionWindow.limit
        )

        var presentKeys = Set(page.items.map(\.group.key))
        let extraExceptions = exceptionPage.items.filter { presentKeys.insert($0.group.key).inserted }

        var focus: SessionListPageItem?
        if let focusSessionId = request.focusSessionId {
            // Deep links resolve against the user's current filter first so a focused
            // row keeps its normal appearance; only if that finds nothing do we fall
            // back to locating it regardless of archive/search/phase state.
            let located = try item(db, containing: focusSessionId, filter: request.filter)
                ?? item(db, containing: focusSessionId,
                        filter: .locating(projectId: request.filter.projectId,
                                          metaAgentEnabled: request.filter.metaAgentEnabled))
            if let located, !presentKeys.contains(located.group.key) {
                focus = located
            }
        }

        var children: [String: [SessionListRow]] = [:]
        var childrenHaveMore: Set<String> = []
        for (groupKey, childWindow) in request.expandedGroups {
            let childPage = try self.children(
                db,
                filter: request.filter,
                groupKey: groupKey,
                after: childWindow.startCursor,
                limit: childWindow.limit
            )
            children[groupKey] = childPage.rows
            if childPage.hasMore { childrenHaveMore.insert(groupKey) }
        }

        let parents = try workstreamParents(db, projectId: request.filter.projectId,
                                           limit: request.workstreamParentLimit + 1,
                                           after: request.workstreamParentCursor)
        return SessionListWindowSnapshot(
            items: page.items,
            exceptions: extraExceptions,
            focus: focus,
            children: children,
            childrenHaveMore: childrenHaveMore,
            workstreamParents: Array(parents.prefix(request.workstreamParentLimit)),
            workstreamParentsHaveMore: parents.count > request.workstreamParentLimit,
            facets: try facets(db, projectId: request.filter.projectId),
            hasMore: page.hasMore,
            exceptionsHaveMore: exceptionPage.hasMore,
            nextCursor: page.nextCursor,
            nextExceptionCursor: exceptionPage.nextCursor,
            pendingProjectionUpdates: try SessionListProjection.pendingCount(db, projectId: request.filter.projectId),
            usedProjection: try usesProjection(db, request.filter)
        )
    }
}
