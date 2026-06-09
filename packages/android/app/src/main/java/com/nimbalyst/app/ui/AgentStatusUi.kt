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

private fun SessionEntity.shouldShowAgentStatus(): Boolean {
    val kind = agentStatusKind?.lowercase()
    return hasQueuedPrompts ||
        kind == "thinking" ||
        kind == "responding" ||
        kind == "tool" ||
        kind == "editing" ||
        kind == "waiting" ||
        kind == "queued" ||
        kind == "error"
}

internal fun SessionEntity.agentStatusDisplayLabel(): String? {
    if (!shouldShowAgentStatus()) return null
    agentStatusLabel?.takeIf { it.isNotBlank() }?.let { return it }
    return when (agentStatusKind?.lowercase()) {
        "thinking" -> "Thinking..."
        "responding" -> "Responding..."
        "tool" -> agentStatusDetail?.takeIf { it.isNotBlank() }?.let { "Using $it..." } ?: "Using tool..."
        "waiting" -> "Waiting for your response"
        "queued" -> "Prompt queued on desktop"
        "error" -> "Agent hit an error"
        else -> if (isExecuting) "Working..." else null
    }
}

internal fun SessionEntity.agentStatusDisplayDetail(): String? =
    agentStatusDetail?.takeIf { it.isNotBlank() && it != agentStatusDisplayLabel() }

@Composable
internal fun AgentStatusInline(session: SessionEntity, modifier: Modifier = Modifier) {
    val label = session.agentStatusDisplayLabel() ?: return
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        if (session.isExecuting) {
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
            if (session.isExecuting) {
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
