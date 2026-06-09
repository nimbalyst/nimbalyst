package com.nimbalyst.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.data.SessionEntity

private const val ACTIVE_AGENT_STATUS_TTL_MS = 5L * 60L * 1000L

private fun String?.normalizedAgentStatusKind(): String? = this?.lowercase()?.trim()

private fun String?.isActiveAgentStatusKind(): Boolean = when (normalizedAgentStatusKind()) {
    "thinking", "responding", "tool", "editing" -> true
    else -> false
}

private fun String?.isDisplayableAgentStatusKind(): Boolean = when (normalizedAgentStatusKind()) {
    "thinking", "responding", "tool", "editing", "waiting", "queued", "error" -> true
    else -> false
}

internal fun SessionEntity.hasStaleActiveAgentStatus(now: Long = System.currentTimeMillis()): Boolean {
    if (!agentStatusKind.isActiveAgentStatusKind() && !isExecuting) return false
    val statusUpdatedAt = agentStatusUpdatedAt ?: updatedAt
    return statusUpdatedAt <= 0 || now - statusUpdatedAt > ACTIVE_AGENT_STATUS_TTL_MS
}

internal fun SessionEntity.effectiveIsExecuting(now: Long = System.currentTimeMillis()): Boolean =
    isExecuting && !hasStaleActiveAgentStatus(now)

internal fun SessionEntity.effectiveAgentStatusKind(now: Long = System.currentTimeMillis()): String? =
    agentStatusKind.takeUnless { hasStaleActiveAgentStatus(now) }

internal fun SessionEntity.effectiveAgentStatusLabel(now: Long = System.currentTimeMillis()): String? =
    agentStatusLabel.takeUnless { hasStaleActiveAgentStatus(now) }

internal fun SessionEntity.effectiveAgentStatusDetail(now: Long = System.currentTimeMillis()): String? =
    agentStatusDetail.takeUnless { hasStaleActiveAgentStatus(now) }

private fun SessionEntity.shouldShowAgentStatus(now: Long = System.currentTimeMillis()): Boolean {
    val kind = effectiveAgentStatusKind(now)
    return hasQueuedPrompts ||
        kind.isDisplayableAgentStatusKind()
}

internal fun SessionEntity.agentStatusDisplayLabel(now: Long = System.currentTimeMillis()): String? {
    if (!shouldShowAgentStatus(now)) return null
    effectiveAgentStatusLabel(now)?.takeIf { it.isNotBlank() }?.let { return it }
    if (hasQueuedPrompts && effectiveAgentStatusKind(now).isNullOrBlank()) {
        return "Prompt queued on desktop"
    }
    return when (effectiveAgentStatusKind(now)?.lowercase()) {
        "thinking" -> "Thinking..."
        "responding" -> "Responding..."
        "tool" -> effectiveAgentStatusDetail(now)?.takeIf { it.isNotBlank() }?.let { "Using $it..." } ?: "Using tool..."
        "editing" -> "Editing..."
        "waiting" -> "Waiting for your response"
        "queued" -> "Prompt queued on desktop"
        "error" -> "Agent hit an error"
        else -> if (effectiveIsExecuting(now)) "Working..." else null
    }
}

internal fun SessionEntity.agentStatusDisplayDetail(now: Long = System.currentTimeMillis()): String? =
    effectiveAgentStatusDetail(now)?.takeIf { it.isNotBlank() && it != agentStatusDisplayLabel(now) }

@Composable
internal fun AgentStatusInline(session: SessionEntity, modifier: Modifier = Modifier) {
    val label = session.agentStatusDisplayLabel() ?: return
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (session.effectiveIsExecuting()) {
            CircularProgressIndicator(
                modifier = Modifier
                    .padding(top = 1.dp)
                    .size(12.dp),
                strokeWidth = 2.dp
            )
        }
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = statusColor(session.agentStatusKind),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
internal fun AgentStatusBanner(session: SessionEntity, modifier: Modifier = Modifier) {
    val label = session.agentStatusDisplayLabel() ?: return
    val detail = session.agentStatusDisplayDetail()
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (session.effectiveIsExecuting()) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelLarge,
                    color = statusColor(session.agentStatusKind)
                )
                if (detail != null) {
                    Text(
                        text = detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }
    }
}

@Composable
private fun statusColor(kind: String?) = when (kind?.lowercase()) {
    "waiting", "queued" -> MaterialTheme.colorScheme.tertiary
    "error" -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.primary
}
