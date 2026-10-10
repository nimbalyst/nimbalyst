package com.nimbalyst.app.ui.sessionlist

import com.nimbalyst.app.data.SessionEntity
import java.util.Calendar

/** Matches iOS `PhaseFilter`, including which kanban phases count as each bucket. */
enum class PhaseFilter {
    ALL, ACTIVE, PLANNING, COMPLETE;

    fun matches(phase: String?): Boolean = when (this) {
        ALL -> true
        ACTIVE -> phase == "implementing" || phase == "validating"
        PLANNING -> phase == "planning" || phase == "backlog"
        COMPLETE -> phase == "complete"
    }
}

/** Header status for a group, with the same precedence as iOS `computeAggregatedStatus`. */
enum class AggregatedStatus { WAITING_FOR_INPUT, PROCESSING, PENDING_PROMPT, UNREAD, IDLE }

enum class GroupKind { STANDALONE, WORKSTREAM, WORKTREE }

enum class TimePeriod { TODAY, YESTERDAY, THIS_WEEK, LAST_WEEK, THIS_MONTH, OLDER }

/** Everything the list filters on. A change to any field rebuilds the list. */
data class SessionListFilter(
    val searchText: String = "",
    val phase: PhaseFilter = PhaseFilter.ALL,
    val includeArchived: Boolean = false,
    val metaAgentEnabled: Boolean = false,
    /** Null lists every machine's sessions. */
    val hostDeviceId: String? = null,
    /** Desktop history synced before sessions carried a host stays visible under a desktop. */
    val includeUnattributedSessions: Boolean = false,
)

val SessionEntity.hasUnread: Boolean
    get() = lastMessageAt != null && lastMessageAt > 0 && (lastReadAt == null || lastMessageAt > lastReadAt)

/** Percent of the context window in use, or null when the session has not reported it. */
val SessionEntity.contextUsagePercent: Int?
    get() {
        val tokens = contextTokens ?: return null
        val window = contextWindow?.takeIf { it > 0 } ?: return null
        return ((tokens.toLong() * 100) / window).toInt()
    }

internal fun aggregatedStatus(sessions: Collection<SessionEntity>): AggregatedStatus = when {
    sessions.any { it.hasQueuedPrompts && it.isExecuting } -> AggregatedStatus.WAITING_FOR_INPUT
    sessions.any { it.isExecuting } -> AggregatedStatus.PROCESSING
    sessions.any { it.hasQueuedPrompts } -> AggregatedStatus.PENDING_PROMPT
    sessions.any { it.hasUnread } -> AggregatedStatus.UNREAD
    else -> AggregatedStatus.IDLE
}

/**
 * Pure grouping for the session list. Mirrors the iOS SQL grouping in
 * `SessionListQueries.swift`: every visible session belongs to exactly one display
 * group. Parent links resolve the visible tree root; manager links do not group
 * sessions. Missing/filtered parents release a subtree, and worktrees stay containers.
 */
object SessionListGrouping {

    data class Group(
        /** Stable key: `s:<id>`, `ws:<parentId>`, `wt:<worktreeId>`. */
        val key: String,
        val kind: GroupKind,
        /** The row the header shows. For a worktree, its oldest member. */
        val parent: SessionEntity,
        /** Rows shown when expanded. Empty for standalone rows and single-session worktrees. */
        val children: List<SessionEntity>,
        val status: AggregatedStatus,
        /** Sort timestamp. A workstream container's own timestamp is not activity. */
        val orderTimestamp: Long,
        val isPinned: Boolean,
        /** Running, waiting or queued anywhere in the group. */
        val isActive: Boolean,
    ) {
        val sessionIds: List<String> get() = listOf(parent.id) + children.map { it.id }.filter { it != parent.id }
    }

    data class Facets(val hasArchived: Boolean, val hasPhaseData: Boolean)

    data class Sections(
        val pinned: List<Group>,
        val timeline: List<Pair<TimePeriod, List<Group>>>,
        /** More groups exist below the window than are shown. */
        val hasMore: Boolean,
        val facets: Facets,
    ) {
        val isEmpty: Boolean get() = pinned.isEmpty() && timeline.isEmpty()
        val allGroups: List<Group> get() = pinned + timeline.flatMap { it.second }
    }

    fun facets(sessions: List<SessionEntity>) = Facets(
        hasArchived = sessions.any { it.isArchived },
        hasPhaseData = sessions.any { !it.phase.isNullOrBlank() },
    )

    fun isVisible(session: SessionEntity, filter: SessionListFilter): Boolean {
        if (!filter.includeArchived && session.isArchived) return false
        filter.hostDeviceId?.let { host ->
            val owned = session.hostDeviceId == host ||
                (filter.includeUnattributedSessions && session.hostDeviceId == null)
            if (!owned) return false
        }
        val query = filter.searchText.trim()
        if (query.isNotEmpty() && session.titleDecrypted?.contains(query, ignoreCase = true) != true) return false
        return true
    }

    /** Group every visible session. Phase filtering and ordering happen here too. */
    fun buildGroups(sessions: List<SessionEntity>, filter: SessionListFilter): List<Group> {
        val visible = sessions.filter { isVisible(it, filter) }
        val byId = visible.associateBy { it.id }

        val parentIds = visible.mapNotNull { child ->
            child.parentSessionId?.let(byId::get)?.takeIf {
                it.projectId == child.projectId && it.worktreeId == child.worktreeId
            }?.id
        }.toSet()
        fun keyFor(s: SessionEntity): String {
            s.worktreeId?.takeIf { it.isNotBlank() }?.let { return "wt:$it" }
            var root = s
            val seen = linkedSetOf<String>()
            while (seen.add(root.id) && root.sessionType !in setOf(WORKSTREAM_TYPE, "blitz")) {
                val parent = root.parentSessionId?.let(byId::get)
                    ?.takeIf { it.projectId == s.projectId && it.worktreeId == s.worktreeId } ?: break
                if (parent.id in seen) {
                    root = byId.getValue(seen.min())
                    break
                }
                root = parent
            }
            return if (root.sessionType == WORKSTREAM_TYPE || root.id in parentIds) "ws:${root.id}"
                else "s:${root.id}"
        }

        return visible.groupBy(::keyFor)
            .mapNotNull { (key, members) -> makeGroup(key, members, byId, filter.phase) }
            .sortedWith(ORDER)
    }

    private fun makeGroup(
        key: String,
        members: List<SessionEntity>,
        byId: Map<String, SessionEntity>,
        phase: PhaseFilter,
    ): Group? {
        val kindTag = key.substringBefore(':')
        val anchor = key.substringAfter(':')
        val kind = when (kindTag) {
            "ws" -> GroupKind.WORKSTREAM
            "wt" -> GroupKind.WORKTREE
            else -> GroupKind.STANDALONE
        }
        val parent = when (kind) {
            GroupKind.WORKTREE -> members.minWith(compareBy<SessionEntity> { it.createdAt }.thenBy { it.id })
            else -> byId[anchor] ?: return null
        }
        val children = treeOrder(when (kind) {
            GroupKind.STANDALONE -> emptyList()
            GroupKind.WORKTREE -> if (members.size > 1) members else emptyList()
            else -> members.filter { it.id != parent.id }
        })

        val phasePass = when {
            phase == PhaseFilter.ALL -> true
            kind == GroupKind.STANDALONE -> phase.matches(parent.phase)
            kind == GroupKind.WORKTREE && children.isEmpty() -> phase.matches(parent.phase)
            parent.sessionType == WORKSTREAM_TYPE -> children.any { phase.matches(it.phase) }
            else -> members.any { phase.matches(it.phase) }
        }
        if (!phasePass) return null

        val orderTimestamp = if (kind == GroupKind.WORKSTREAM && parent.sessionType == WORKSTREAM_TYPE && children.isNotEmpty()) {
            children.maxOf { it.updatedAt }
        } else {
            members.maxOf { it.updatedAt }
        }
        val statusSource = if (kind == GroupKind.WORKSTREAM && parent.sessionType == WORKSTREAM_TYPE && children.isNotEmpty()) children else members
        return Group(
            key = key,
            kind = kind,
            parent = parent,
            children = children,
            status = aggregatedStatus(statusSource),
            orderTimestamp = orderTimestamp,
            isPinned = members.any { it.isPinned },
            isActive = members.any { it.isExecuting || it.hasQueuedPrompts },
        )
    }

    /** Preorder with pinned/subtree activity ordering; malformed cycles stay visible. */
    private fun treeOrder(rows: List<SessionEntity>): List<SessionEntity> {
        val byId = rows.associateBy { it.id }
        val children = rows.groupBy { it.parentSessionId }
        fun activity(row: SessionEntity, seen: Set<String> = emptySet()): Long =
            if (row.id in seen) row.updatedAt else maxOf(row.updatedAt,
                children[row.id].orEmpty().maxOfOrNull { activity(it, seen + row.id) } ?: row.updatedAt)
        val order = compareByDescending<SessionEntity> { it.isPinned }
            .thenByDescending { activity(it) }.thenByDescending { it.id }
        val result = mutableListOf<SessionEntity>()
        val seen = mutableSetOf<String>()
        fun visit(row: SessionEntity) {
            if (!seen.add(row.id)) return
            result.add(row)
            children[row.id].orEmpty().sortedWith(order).forEach(::visit)
        }
        rows.filter { it.parentSessionId !in byId }.sortedWith(order).forEach(::visit)
        rows.sortedWith(order).forEach(::visit)
        return result
    }

    fun indentationLevel(session: SessionEntity, group: Group): Int {
        val byId = (group.children + group.parent).associateBy { it.id }
        var depth = 0
        var current = session
        val seen = mutableSetOf(current.id)
        while (true) {
            val parent = current.parentSessionId?.let(byId::get) ?: break
            if (!seen.add(parent.id)) break
            depth++
            current = parent
        }
        return depth.coerceAtMost(2)
    }

    /**
     * Split ordered groups into what the list renders. Pinned groups lead in their own
     * section, and the rest is bucketed by time. Only the newest [windowSize] timeline groups are shown; running
     * or queued groups beyond that window are merged in anyway -- the iOS exception lane --
     * so an active session is never stranded below the fold.
     */
    fun sections(
        groups: List<Group>,
        facets: Facets,
        windowSize: Int,
        now: Calendar = Calendar.getInstance(),
    ): Sections {
        val pinned = groups.filter { it.isPinned }
        val timeline = groups.filter { !it.isPinned }
        val window = timeline.take(windowSize)
        val exceptions = timeline.drop(windowSize).filter { it.isActive }
        return Sections(
            pinned = pinned,
            timeline = groupByTime(window + exceptions, now),
            hasMore = timeline.size > window.size + exceptions.size,
            facets = facets,
        )
    }

    fun groupByTime(groups: List<Group>, now: Calendar = Calendar.getInstance()): List<Pair<TimePeriod, List<Group>>> {
        val today = (now.clone() as Calendar).apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        val yesterday = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -1) }
        val thisWeek = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -7) }
        val lastWeek = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -14) }
        val thisMonth = (today.clone() as Calendar).apply { add(Calendar.MONTH, -1) }

        val buckets = linkedMapOf<TimePeriod, MutableList<Group>>()
        groups.sortedWith(ORDER).forEach { group ->
            val ts = group.orderTimestamp
            val period = when {
                ts >= today.timeInMillis -> TimePeriod.TODAY
                ts >= yesterday.timeInMillis -> TimePeriod.YESTERDAY
                ts >= thisWeek.timeInMillis -> TimePeriod.THIS_WEEK
                ts >= lastWeek.timeInMillis -> TimePeriod.LAST_WEEK
                ts >= thisMonth.timeInMillis -> TimePeriod.THIS_MONTH
                else -> TimePeriod.OLDER
            }
            buckets.getOrPut(period) { mutableListOf() }.add(group)
        }
        return buckets.map { (period, list) -> period to list.toList() }
    }

    /** Workstreams a session can be moved into, newest first. */
    fun workstreamParents(sessions: List<SessionEntity>): List<SessionEntity> = sessions
        .filter { it.sessionType == WORKSTREAM_TYPE && !it.isArchived }
        .sortedByDescending { it.updatedAt }

    /** Same keyset order as iOS: timestamp desc, then key desc so ties are stable. */
    private val ORDER = compareByDescending<Group> { it.orderTimestamp }.thenByDescending { it.key }

    const val META_AGENT_ROLE = "meta-agent"
    const val WORKSTREAM_TYPE = "workstream"
}
