import SwiftUI
import Foundation

// MARK: - Meta Agent Group Model

/// A meta-agent session paired with the sub-agent sessions it spawned.
///
/// Mirrors the desktop `MetaAgentGroup` (see `MetaAgentGroup.tsx` and the grouping
/// in `SessionHistory.tsx` ~2119-2162): the meta session has
/// `agentRole == "meta-agent"`; each child has `createdBySessionId == metaSession.id`.
/// This is a DIFFERENT link than workstream grouping (which uses `parentSessionId`).
struct MetaAgentGroup: Identifiable {
    let metaSession: Session
    let children: [Session]
    var id: String { metaSession.id }

    /// Most recent update across the meta session and its children (used for ordering).
    var latestUpdate: Int {
        max(metaSession.updatedAt, children.map(\.updatedAt).max() ?? metaSession.updatedAt)
    }
}

/// Result of partitioning a session list into meta-agent groups.
struct MetaAgentGrouping {
    let groups: [MetaAgentGroup]
    /// IDs of every session that belongs to a meta-agent group (meta + children),
    /// so callers can exclude them from the flat / workstream / worktree lists.
    let groupedSessionIds: Set<String>
}

/// Pure grouping logic, and the reference definition of the desktop meta-agent
/// grouping rules.
///
/// The sidebar itself resolves grouping in SQL now (`SessionListSQL.memberCTE`), so a
/// collapsed group never materializes its children;
/// `SessionListWindowTests.testGroupingMatchesReferenceGrouper` asserts that the SQL
/// reproduces what this returns.
///
/// Mirrors `SessionHistory.tsx` (~2119-2162): collect meta sessions by
/// `agentRole == "meta-agent"`, attach children whose `createdBySessionId`
/// matches a known meta session, and report both so they can be excluded from the
/// flat list. A missing or unknown `createdBySessionId` is left ungrouped, so it
/// falls back to a normal row.
enum MetaAgentGrouper {
    static let metaAgentRole = "meta-agent"

    static func group(sessions: [Session], enabled: Bool) -> MetaAgentGrouping {
        // When the alpha feature is off, produce no groups so the list behaves
        // exactly as before (mirrors desktop's `if (isMetaAgentEnabled)` guard).
        guard enabled else {
            return MetaAgentGrouping(groups: [], groupedSessionIds: [])
        }

        let metaSessionIds = Set(
            sessions.filter { $0.agentRole == metaAgentRole }.map(\.id)
        )
        guard !metaSessionIds.isEmpty else {
            return MetaAgentGrouping(groups: [], groupedSessionIds: [])
        }

        // Children: sessions whose createdBySessionId points at a KNOWN meta session.
        // A nil or unknown createdBySessionId is skipped here, so the caller renders
        // it as an ordinary row. A session that is itself a meta is never treated as a
        // child, so a meta nested under another meta can't render twice (child + header).
        var childrenByMeta: [String: [Session]] = [:]
        for session in sessions {
            guard let parentId = session.createdBySessionId,
                  metaSessionIds.contains(parentId),
                  !metaSessionIds.contains(session.id) else { continue }
            childrenByMeta[parentId, default: []].append(session)
        }

        var groups: [MetaAgentGroup] = []
        var groupedIds = Set<String>()
        for meta in sessions where meta.agentRole == metaAgentRole {
            let children = (childrenByMeta[meta.id] ?? [])
                .sorted { $0.updatedAt > $1.updatedAt }
            groups.append(MetaAgentGroup(metaSession: meta, children: children))
            groupedIds.insert(meta.id)
            for child in children { groupedIds.insert(child.id) }
        }

        // Newest group first (mirrors desktop's `metaAgentItems.sort(compareUnifiedItems)`).
        groups.sort { $0.latestUpdate > $1.latestUpdate }

        return MetaAgentGrouping(groups: groups, groupedSessionIds: groupedIds)
    }
}

// MARK: - Expand/Collapse Persistence

/// Persists which meta-agent groups are COLLAPSED, per project, in UserDefaults.
///
/// Desktop semantics (`SessionHistory.tsx:3645`,
/// `!collapsedGroups.includes('meta-agent:<id>')`): meta-agent groups default to
/// EXPANDED and only explicitly-collapsed groups are remembered. This store mirrors
/// that by persisting the *collapsed* set, so the default state is expanded.
///
/// It is the deliberate inverse of `expandedWorkstreams` in `SessionListView`
/// (which stores expanded IDs and defaults to collapsed); the inversion is exactly
/// what makes the iOS default match the desktop default-expanded behavior. The
/// persistence shape (a UserDefaults JSON-encoded `Set<String>`, keyed per project)
/// matches `expandedWorkstreams`.
struct MetaAgentExpansion {
    let projectId: String
    private let defaults: UserDefaults

    init(projectId: String, defaults: UserDefaults = .standard) {
        self.projectId = projectId
        self.defaults = defaults
    }

    private var storageKey: String { "collapsedMetaAgents_\(projectId)" }

    /// The set of meta-agent session IDs currently collapsed.
    func collapsedIds() -> Set<String> {
        guard let data = defaults.data(forKey: storageKey),
              let ids = try? JSONDecoder().decode(Set<String>.self, from: data) else {
            return []
        }
        return ids
    }

    /// Persist the full collapsed set.
    func setCollapsedIds(_ ids: Set<String>) {
        if let data = try? JSONEncoder().encode(ids) {
            defaults.set(data, forKey: storageKey)
        }
    }

    /// Whether a meta-agent group is expanded (default `true`, mirroring desktop).
    func isExpanded(_ metaSessionId: String) -> Bool {
        !collapsedIds().contains(metaSessionId)
    }

    /// Update the expanded/collapsed state for one meta-agent group and persist.
    func setExpanded(_ expanded: Bool, for metaSessionId: String) {
        var ids = collapsedIds()
        if expanded {
            ids.remove(metaSessionId)
        } else {
            ids.insert(metaSessionId)
        }
        setCollapsedIds(ids)
    }
}

// MARK: - Meta Agent Group View

/// A meta-agent group rendered to MATCH the desktop `MetaAgentGroup.tsx` interaction:
///
/// - Tapping the header ROW opens (navigates to) the meta-agent session's transcript,
///   exactly like a normal session row — regardless of whether it has children. This
///   reuses the same `NavigationLink(value:)` mechanism every other row in
///   `SessionListView` uses on iPhone and iPad. Desktop does
///   the same: its header `onClick` calls `onSessionSelect(metaSession.id)`.
/// - A SEPARATE leading chevron `Button` toggles expand/collapse independently, without
///   navigating — mirroring desktop's chevron `<button>` (`stopPropagation` + `onToggle`).
///   It uses `.buttonStyle(.plain)` + its own `contentShape` so the List hit-tests it as
///   a distinct tap target (the same proven pattern as `FileTreeRow`'s plain-button
///   toggle), and it sits OUTSIDE the `NavigationLink` so its taps can never
///   fall through to push navigation.
/// - Child sessions render manually as indented sibling rows (NOT via `DisclosureGroup`),
///   each navigating to its own transcript — matching desktop, which lays children out as
///   flat `pl-5` rows beneath the header.
///
/// Expansion defaults to expanded and persists the collapsed set (see `MetaAgentExpansion`).
/// The group-level context menu is attached to the header row ONLY, so it never leaks onto
/// the child rows (which are now separate List rows rather than DisclosureGroup contents).
struct MetaAgentGroupView<MenuContent: View>: View {
    let item: SessionListPageItem
    /// The loaded page of sub-agent rows. A collapsed group loads none of them; a
    /// large one loads a bounded page at a time.
    let children: [SessionListRow]
    let hasMoreChildren: Bool
    @Binding var isExpanded: Bool
    var voiceFocusedSessionId: String?
    var onLoadMoreChildren: () -> Void
    /// Group-level context menu, attached to the header row only.
    @ViewBuilder var headerContextMenu: () -> MenuContent

    /// Aggregate status across the meta session + all children, computed in SQL over
    /// the complete cached group (mirrors desktop `MetaAgentGroupStatus`, which spans
    /// the whole group) rather than over the children that happen to be loaded.
    private var aggregateStatus: AggregatedStatus { item.group.status }

    private var title: String {
        item.parent.titleDecrypted ?? "Meta Agent"
    }

    var body: some View {
        // A Group flattens into separate List rows: one header row, then one row per
        // visible child. Children are rendered manually (no DisclosureGroup) so the header
        // can navigate while the chevron toggles independently.
        Group {
            metaHeaderRow
                .contextMenu { headerContextMenu() }

            if isExpanded {
                ForEach(children) { child in
                    childRow(child)
                }
                if hasMoreChildren {
                    ChildPageLoader(onAppear: onLoadMoreChildren)
                }
            }
        }
    }

    /// Header row: a leading chevron toggle (independent tap target) followed by the
    /// navigable meta-session label. Tapping the label opens the meta session's transcript
    /// via the same navigation mechanism a normal session row uses.
    @ViewBuilder
    private var metaHeaderRow: some View {
        // The chevron Button sits OUTSIDE the NavigationLink (a sibling in the
        // row's HStack), so its tap area never overlaps the link's — eliminating the
        // tap-target conflict. The link covers only the label, which expands via its
        // trailing Spacer to fill the rest of the row.
        HStack(spacing: 8) {
            chevronToggle
            NavigationLink(value: WorkspaceSelection.session(item.parent.id)) {
                MetaAgentHeader(title: title, childCount: item.group.childCount, status: aggregateStatus)
            }
        }
    }

    /// Independent expand/collapse control. Mirrors desktop's chevron `<button>`
    /// (`stopPropagation` + `onToggle`) and `FileTreeRow`'s plain-styled toggle, so it is a
    /// distinct tap target that does NOT trigger navigation. The chevron is always shown
    /// (matching desktop); with no children, toggling simply reveals nothing.
    private var chevronToggle: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                isExpanded.toggle()
            }
        } label: {
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(NimbalystColors.textFaint)
                .rotationEffect(.degrees(isExpanded ? 90 : 0))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "Collapse" : "Expand")
    }

    /// A child (sub-agent) session row, indented to nest under the meta header and
    /// navigating to its own transcript — exactly like a normal session row.
    @ViewBuilder
    private func childRow(_ child: SessionListRow) -> some View {
        NavigationLink(value: WorkspaceSelection.session(child.id)) {
            SessionRow(session: child, isChild: true, voiceFocusedSessionId: voiceFocusedSessionId)
                .padding(.leading, 20)
        }
    }
}

// MARK: - Meta Agent Header

/// Header row for a meta-agent group: hub-style icon, title, child-count badge, and
/// aggregate status indicator. Parallels `WorkstreamHeader` but uses the meta-agent
/// glyph (matching the "New Meta Agent" creation button) and only shows the count
/// badge when there are children (mirroring desktop's `MetaAgentGroup`).
struct MetaAgentHeader: View {
    let title: String
    let childCount: Int
    let status: AggregatedStatus

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 14))
                .foregroundStyle(NimbalystColors.primary)

            Text(title)
                .font(.body)
                .fontWeight(.medium)
                .lineLimit(1)

            if childCount > 0 {
                Text("\(childCount)")
                    .font(.caption2)
                    .fontWeight(.medium)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.15))
                    .clipShape(Capsule())
            }

            Spacer()

            statusIndicator
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch status {
        case .waitingForInput:
            Image(systemName: "exclamationmark.bubble.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        case .processing:
            ProgressView()
                .controlSize(.small)
        case .pendingPrompt:
            Image(systemName: "clock.fill")
                .font(.caption)
                .foregroundStyle(.orange)
        case .unread:
            Circle()
                .fill(NimbalystColors.primary)
                .frame(width: 8, height: 8)
        case .idle:
            EmptyView()
        }
    }
}
