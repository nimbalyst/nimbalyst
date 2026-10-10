package com.nimbalyst.app.ui.sessionlist

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SmsFailed
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.ui.components.ContextUsageBadge
import com.nimbalyst.app.ui.components.PhaseBadge
import com.nimbalyst.app.ui.components.ProviderBadge
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.utils.RelativeTimestamp

private val WaitingColor = Color(0xFFFF9500) // iOS system orange, used for "needs you"
private val GroupIconSize = 16.dp

/** One session row, matching iOS `SessionRow`. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun SessionRow(
    session: SessionEntity,
    isSelected: Boolean,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
    isChild: Boolean = false,
    treeIndentationLevel: Int = 0,
) {
    val unread = session.hasUnread
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(if (isSelected) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(start = (if (isChild) 24.dp else 8.dp) + (treeIndentationLevel.coerceIn(0, 2) * 12).dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        // Same width as the GroupHeader icon so session and workstream titles share a left edge.
        Box(modifier = Modifier.width(GroupIconSize), contentAlignment = Alignment.Center) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .alpha(if (unread) 1f else 0f)
                    .clip(CircleShape)
                    .background(NimbalystColors.primary)
            )
        }
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = session.titleDecrypted ?: stringResource(R.string.session_list_untitled_session),
                    style = if (isChild) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge,
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (session.isArchived) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (session.isPinned) {
                    Icon(
                        Icons.Default.PushPin,
                        contentDescription = stringResource(R.string.session_list_pinned_indicator),
                        tint = NimbalystColors.textFaint,
                        modifier = Modifier.size(12.dp)
                    )
                }
                // A queued prompt is actionable, so it outranks the spinner (iOS order).
                if (session.hasQueuedPrompts) {
                    Icon(
                        Icons.Default.Schedule,
                        contentDescription = stringResource(R.string.session_list_queued_indicator),
                        tint = WaitingColor,
                        modifier = Modifier.size(14.dp)
                    )
                } else if (session.isExecuting) {
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (session.isArchived) {
                    Icon(
                        Icons.Outlined.Archive,
                        contentDescription = stringResource(R.string.session_list_archived_indicator),
                        tint = NimbalystColors.textFaint,
                        modifier = Modifier.size(12.dp)
                    )
                }
                ProviderBadge(provider = session.provider, model = session.model)
                session.phase?.takeIf { it.isNotBlank() }?.let { PhaseBadge(phase = it) }
                session.contextUsagePercent?.let { ContextUsageBadge(percent = it) }
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    text = RelativeTimestamp.format(session.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** Header for a workstream, worktree, or meta-agent group, like iOS `WorkstreamHeader`. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun GroupHeader(
    group: SessionListGrouping.Group,
    isExpanded: Boolean,
    isSelected: Boolean,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)?,
    /** When set, the chevron toggles on its own and [onClick] opens the header session. */
    onToggleExpanded: (() -> Unit)? = null,
) {
    val (icon, tint) = when (group.kind) {
        GroupKind.WORKTREE -> Icons.AutoMirrored.Filled.CallSplit to WaitingColor
        else -> Icons.Default.Folder to NimbalystColors.primary
    }
    val fallbackTitle = when (group.kind) {
        GroupKind.WORKTREE -> stringResource(R.string.session_list_worktree)
        else -> stringResource(R.string.session_list_workstream)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(if (isSelected) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 8.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(GroupIconSize))
        // Title and count share one weighted slot. A sibling weighted Spacer would take
        // half the free width and truncate the title early.
        Row(
            modifier = Modifier.weight(1f),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(
                text = group.parent.titleDecrypted ?: fallbackTitle,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false)
            )
            Text(
                text = group.children.size.toString(),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.15f))
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            )
        }
        AggregatedStatusIndicator(group.status)
        if (group.children.isNotEmpty()) {
            Spacer(modifier = Modifier.width(2.dp))
            Icon(
                imageVector = if (isExpanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = stringResource(
                    if (isExpanded) R.string.session_list_collapse else R.string.session_list_expand
                ),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .size(if (onToggleExpanded != null) 28.dp else 18.dp)
                    .then(
                        if (onToggleExpanded != null) {
                            Modifier.clip(CircleShape).clickable(onClick = onToggleExpanded).padding(5.dp)
                        } else {
                            Modifier
                        }
                    )
            )
        }
    }
}

@Composable
internal fun AggregatedStatusIndicator(status: AggregatedStatus) {
    when (status) {
        AggregatedStatus.WAITING_FOR_INPUT -> Icon(
            Icons.Default.SmsFailed,
            contentDescription = stringResource(R.string.session_list_status_waiting),
            tint = WaitingColor,
            modifier = Modifier.size(14.dp)
        )
        AggregatedStatus.PROCESSING -> CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
        AggregatedStatus.PENDING_PROMPT -> Icon(
            Icons.Default.Schedule,
            contentDescription = stringResource(R.string.session_list_queued_indicator),
            tint = WaitingColor,
            modifier = Modifier.size(14.dp)
        )
        AggregatedStatus.UNREAD -> Box(
            modifier = Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(NimbalystColors.primary)
        )
        AggregatedStatus.IDLE -> Unit
    }
}

@Composable
internal fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 8.dp, top = 16.dp, bottom = 4.dp)
    )
}

@Composable
internal fun timePeriodLabel(period: TimePeriod): String = stringResource(
    when (period) {
        TimePeriod.TODAY -> R.string.session_list_period_today
        TimePeriod.YESTERDAY -> R.string.session_list_period_yesterday
        TimePeriod.THIS_WEEK -> R.string.session_list_period_this_week
        TimePeriod.LAST_WEEK -> R.string.session_list_period_last_week
        TimePeriod.THIS_MONTH -> R.string.session_list_period_this_month
        TimePeriod.OLDER -> R.string.session_list_period_older
    }
)
