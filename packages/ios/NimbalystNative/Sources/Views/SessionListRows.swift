import SwiftUI

// Presentation types and row views for the session sidebar, extracted from
// `SessionListView.swift` so that file holds the screen and its actions rather than
// the whole list vocabulary. Nothing here changed visually in the extraction.

// MARK: - Time Period Grouping

enum TimePeriod: String, CaseIterable {
    case today = "Today"
    case yesterday = "Yesterday"
    case thisWeek = "This Week"
    case lastWeek = "Last Week"
    case thisMonth = "This Month"
    case older = "Older"

    static func classify(epochMs: Int) -> TimePeriod {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        let calendar = Calendar.current
        let now = Date()

        if calendar.isDateInToday(date) {
            return .today
        } else if calendar.isDateInYesterday(date) {
            return .yesterday
        } else {
            let startOfWeek = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? now
            let startOfLastWeek = calendar.date(byAdding: .weekOfYear, value: -1, to: startOfWeek) ?? now
            let startOfMonth = calendar.dateInterval(of: .month, for: now)?.start ?? now

            if date >= startOfWeek {
                return .thisWeek
            } else if date >= startOfLastWeek {
                return .lastWeek
            } else if date >= startOfMonth {
                return .thisMonth
            } else {
                return .older
            }
        }
    }
}

/// A unified item in the session list: a standalone session row or a group header.
enum SessionListItem: Identifiable {
    case session(SessionListRow)
    case group(SessionListPageItem)

    var id: String {
        switch self {
        case .session(let row): return row.id
        case .group(let item): return item.group.key
        }
    }

    var effectiveUpdatedAt: Int {
        switch self {
        case .session(let row): return row.updatedAt
        case .group(let item): return item.group.orderTimestamp
        }
    }

    /// Secondary sort key, matching the SQL keyset tie-breaker so that rows keep a
    /// stable order when several share a timestamp.
    var sortKey: String {
        switch self {
        case .session(let row): return "s:\(row.id)"
        case .group(let item): return item.group.key
        }
    }
}

struct GroupedSessionItems: Identifiable {
    let period: TimePeriod
    let items: [SessionListItem]
    var id: String { period.rawValue }
}

// MARK: - Aggregated Status

public enum AggregatedStatus: Sendable {
    case waitingForInput  // hasPendingPrompt + isExecuting
    case processing       // isExecuting
    case pendingPrompt    // hasQueuedPrompts
    case unread           // hasUnread
    case idle
}

/// The fields aggregate status is derived from, so the same precedence works for a
/// full `Session` and for the list's lighter `SessionListRow` projection.
protocol SessionStatusFields {
    var isExecuting: Bool { get }
    var hasQueuedPrompts: Bool { get }
    var hasUnread: Bool { get }
}

extension Session: SessionStatusFields {}
extension SessionListRow: SessionStatusFields {}

func computeAggregatedStatus(_ children: [some SessionStatusFields]) -> AggregatedStatus {
    if children.contains(where: { $0.hasQueuedPrompts && $0.isExecuting }) {
        return .waitingForInput
    }
    if children.contains(where: { $0.isExecuting }) {
        return .processing
    }
    if children.contains(where: { $0.hasQueuedPrompts }) {
        return .pendingPrompt
    }
    if children.contains(where: { $0.hasUnread }) {
        return .unread
    }
    return .idle
}

// MARK: - Phase Filter

public enum PhaseFilter: String, CaseIterable, Sendable {
    case all = "All"
    case active = "Active"
    case planning = "Planning"
    case complete = "Done"

    /// Key passed to SQL, where the same phase sets are evaluated (see
    /// `SessionListSQL.memberFlags`). Kept separate from `rawValue`, which is the
    /// user-visible picker label.
    public var sqlKey: String {
        switch self {
        case .all: return "all"
        case .active: return "active"
        case .planning: return "planning"
        case .complete: return "complete"
        }
    }

    /// Whether a session matches this filter.
    func matches(_ session: Session) -> Bool {
        switch self {
        case .all: return true
        case .active: return session.phase == "implementing" || session.phase == "validating"
        case .planning: return session.phase == "planning" || session.phase == "backlog"
        case .complete: return session.phase == "complete"
        }
    }
}

// MARK: - Project Tab

enum ProjectTab: String, CaseIterable {
    case sessions = "Sessions"
    case files = "Files"
}

// MARK: - WorkstreamSection

/// A workstream or worktree group. Collapsed, it renders only the header — its child
/// rows are fetched (and paged) on expansion, so a group with thousands of children
/// costs the same as one with three.
struct WorkstreamSection: View {
    let item: SessionListPageItem
    let children: [SessionListRow]
    let hasMoreChildren: Bool
    @Binding var isExpanded: Bool
    var voiceFocusedSessionId: String?
    var onLoadMoreChildren: () -> Void

    private var isWorktree: Bool { item.group.kind == .worktree }

    private var title: String {
        item.parent.titleDecrypted ?? (isWorktree ? "Worktree" : "Workstream")
    }

    var body: some View {
        Group {
            if item.group.childCount == 0 {
                // Single-session worktree: navigable row for the session
                NavigationLink(value: WorkspaceSelection.session(item.parent.id)) {
                    WorkstreamHeader(
                        title: title,
                        childCount: 0,
                        status: item.group.status,
                        isWorktree: isWorktree
                    )
                }
            } else {
                DisclosureGroup(isExpanded: $isExpanded) {
                    ForEach(children) { child in
                        NavigationLink(value: WorkspaceSelection.session(child.id)) {
                            SessionRow(
                                session: child,
                                isChild: true,
                                voiceFocusedSessionId: voiceFocusedSessionId
                            )
                        }
                    }
                    if hasMoreChildren {
                        ChildPageLoader(onAppear: onLoadMoreChildren)
                    }
                } label: {
                    WorkstreamHeader(
                        title: title,
                        childCount: item.group.childCount,
                        status: item.group.status,
                        isWorktree: isWorktree
                    )
                }
            }
        }
    }
}

/// Trailing row inside an expanded group that pulls the next page of children as it
/// scrolls into view.
struct ChildPageLoader: View {
    let onAppear: () -> Void

    var body: some View {
        HStack {
            Spacer()
            ProgressView().controlSize(.small)
            Spacer()
        }
        .padding(.vertical, 4)
        .onAppear(perform: onAppear)
    }
}

// MARK: - WorkstreamHeader

struct WorkstreamHeader: View {
    let title: String
    let childCount: Int
    let status: AggregatedStatus
    var isWorktree: Bool = false

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: isWorktree ? "arrow.triangle.branch" : "folder.fill")
                .font(.system(size: 14))
                .foregroundStyle(isWorktree ? .orange : NimbalystColors.primary)

            Text(title)
                .font(.body)
                .fontWeight(.medium)
                .lineLimit(1)

            Text("\(childCount)")
                .font(.caption2)
                .fontWeight(.medium)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.secondary.opacity(0.15))
                .clipShape(Capsule())

            Spacer()

            AggregatedStatusIndicator(status: status)
        }
        .padding(.vertical, 4)
    }
}

/// Shared trailing indicator for group headers.
struct AggregatedStatusIndicator: View {
    let status: AggregatedStatus

    var body: some View {
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

// MARK: - Session Row

struct SessionRow: View {
    let session: SessionListRow
    var isChild: Bool = false
    var voiceFocusedSessionId: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            // Unread indicator
            Circle()
                .fill(NimbalystColors.primary)
                .frame(width: 8, height: 8)
                .opacity(session.hasUnread ? 1 : 0)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(session.titleDecrypted ?? "Untitled Session")
                        .font(isChild ? .callout : .body)
                        .fontWeight(session.hasUnread ? .semibold : .regular)
                        .lineLimit(1)
                        .foregroundStyle(session.isArchived ? .secondary : .primary)

                    Spacer()

                    // Voice focus indicator
                    if voiceFocusedSessionId == session.id {
                        Image(systemName: "mic.fill")
                            .font(.caption2)
                            .foregroundStyle(NimbalystColors.primary)
                    }

                    // Status indicators - pending prompt takes priority (it's actionable)
                    if session.hasQueuedPrompts {
                        Image(systemName: "clock.fill")
                            .foregroundStyle(.orange)
                            .font(.caption)
                    } else if session.isExecuting {
                        ProgressView()
                            .controlSize(.small)
                    }
                }

                HStack(spacing: 6) {
                    if session.isArchived {
                        Image(systemName: "archivebox")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    ProviderBadge(provider: session.provider, model: session.model)

                    if let phase = session.phase, !phase.isEmpty {
                        PhaseBadge(phase: phase)
                    }

                    Spacer()

                    Text(RelativeTimestamp.format(epochMs: session.updatedAt))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Phase Badge

struct PhaseBadge: View {
    let phase: String

    var body: some View {
        Text(displayName)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(phaseColor.opacity(0.15))
            .foregroundStyle(phaseColor)
            .clipShape(Capsule())
    }

    private var displayName: String {
        switch phase {
        case "backlog": return "Backlog"
        case "planning": return "Planning"
        case "implementing": return "Implementing"
        case "validating": return "Validating"
        case "complete": return "Complete"
        default: return phase.capitalized
        }
    }

    private var phaseColor: Color {
        switch phase {
        case "backlog": return Color(hex: 0x6b7280)  // gray
        case "planning": return Color(hex: 0x60a5fa)  // blue
        case "implementing": return Color(hex: 0xeab308)  // yellow
        case "validating": return Color(hex: 0xa78bfa)  // purple
        case "complete": return Color(hex: 0x4ade80)  // green
        default: return .gray
        }
    }
}

// MARK: - Tag Pill

struct TagPill: View {
    let tag: String

    var body: some View {
        Text(tag)
            .font(.system(size: 9))
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Color.secondary.opacity(0.12))
            .foregroundStyle(.secondary)
            .clipShape(Capsule())
    }
}

/// Badge showing the AI provider name with model info and appropriate color.
struct ProviderBadge: View {
    let provider: String?
    let model: String?

    var body: some View {
        if let name = displayName {
            Text(name)
                .font(.caption2)
                .fontWeight(.medium)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(badgeColor.opacity(0.15))
                .foregroundStyle(badgeColor)
                .clipShape(Capsule())
        }
    }

    private var displayName: String? {
        // Delegate to the shared model label helper so iOS stays in sync with
        // the Electron-side tables in `packages/runtime/src/ai/modelConstants.ts`.
        // Returns nil for unknown provider/model combos so the badge is hidden
        // rather than showing a guessed label.
        ModelLabel.shortLabel(provider: provider, model: model)
    }

    private var badgeColor: Color {
        let prov = provider?.lowercased() ?? ""
        switch prov {
        case "claude-code", "claude": return NimbalystColors.primary
        case "openai": return .green
        case "lm-studio": return .purple
        default: return .gray
        }
    }
}

/// Compact context usage indicator showing percentage with color coding.
struct ContextUsageBadge: View {
    let percent: Int

    var body: some View {
        Text("\(percent)%")
            .font(.caption2)
            .fontWeight(.medium)
            .monospacedDigit()
            .foregroundStyle(badgeColor)
    }

    private var badgeColor: Color {
        if percent >= 90 {
            return NimbalystColors.error
        } else if percent >= 70 {
            return NimbalystColors.warning
        } else {
            return NimbalystColors.textFaint
        }
    }
}
