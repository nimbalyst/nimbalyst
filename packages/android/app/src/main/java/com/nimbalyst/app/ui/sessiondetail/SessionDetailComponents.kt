package com.nimbalyst.app.ui.sessiondetail

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.data.QueuedPromptEntity
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.ui.components.ContextUsageBar
import com.nimbalyst.app.ui.components.ModelLabel
import com.nimbalyst.app.ui.theme.NimbalystColors

/** Mirrors iOS `Session.contextUsagePercent`. */
internal fun SessionEntity.contextUsagePercent(): Int? {
    val tokens = contextTokens ?: return null
    val window = contextWindow?.takeIf { it > 0 } ?: return null
    return minOf(100, (tokens.toDouble() / window * 100).toInt())
}

/** Executing / waiting state, model label, and context usage (iOS `statusBar`). */
@Composable
fun SessionStatusBar(session: SessionEntity, modifier: Modifier = Modifier) {
    val percent = session.contextUsagePercent()
    if (!session.isExecuting && !session.hasQueuedPrompts && percent == null) return

    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(NimbalystColors.backgroundSecondary)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        if (session.hasQueuedPrompts) {
            StatusLabel(stringResource(R.string.session_detail_waiting)) {
                Icon(
                    Icons.Filled.Schedule,
                    contentDescription = null,
                    tint = NimbalystColors.warning,
                    modifier = Modifier.size(14.dp)
                )
            }
        } else if (session.isExecuting) {
            StatusLabel(stringResource(R.string.session_detail_executing)) {
                CircularProgressIndicator(
                    modifier = Modifier.size(12.dp),
                    color = NimbalystColors.primary,
                    strokeWidth = 1.5.dp
                )
            }
        }

        Spacer(Modifier.weight(1f))

        ModelLabel.shortLabel(session.provider, session.model)?.let { label ->
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = NimbalystColors.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        percent?.let { ContextUsageBar(percent = it) }
    }
}

@Composable
private fun StatusLabel(text: String, leading: @Composable () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        leading()
        Text(text = text, style = MaterialTheme.typography.labelMedium, color = NimbalystColors.textMuted)
    }
}

/** Prompts waiting on the desktop, between the transcript and the composer (iOS `QueuedPromptsList`). */
@Composable
fun QueuedPromptsList(prompts: List<QueuedPromptEntity>, modifier: Modifier = Modifier) {
    if (prompts.isEmpty()) return
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(NimbalystColors.backgroundSecondary)
            .padding(bottom = 6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Icon(
                Icons.Filled.History,
                contentDescription = null,
                tint = NimbalystColors.warning,
                modifier = Modifier.size(12.dp)
            )
            Text(
                text = pluralStringResource(R.plurals.session_detail_queued_count, prompts.size, prompts.size),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = NimbalystColors.textMuted
            )
        }
        // Bounded so a long queue cannot push the composer off screen.
        LazyColumn(
            modifier = Modifier.heightIn(max = 160.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            items(prompts.size, key = { prompts[it].id }) { index ->
                QueuedPromptRow(index = index, prompt = prompts[index])
            }
        }
    }
}

@Composable
private fun QueuedPromptRow(index: Int, prompt: QueuedPromptEntity) {
    Row(
        modifier = Modifier
            .padding(horizontal = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(NimbalystColors.backgroundTertiary)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Box(
            modifier = Modifier
                .size(18.dp)
                .clip(CircleShape)
                .background(NimbalystColors.background),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "${index + 1}",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                color = NimbalystColors.primary
            )
        }
        Text(
            text = prompt.promptTextDecrypted ?: "...",
            style = MaterialTheme.typography.labelMedium,
            color = NimbalystColors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f)
        )
        prompt.source?.let { source ->
            val fromPhone = source == "keyboard" || source == "voice"
            Icon(
                imageVector = if (fromPhone) Icons.Filled.Smartphone else Icons.Filled.Computer,
                contentDescription = stringResource(
                    if (fromPhone) R.string.session_detail_queued_from_phone else R.string.session_detail_queued_from_desktop
                ),
                tint = NimbalystColors.textFaint,
                modifier = Modifier.size(12.dp)
            )
        }
    }
}

/** Thumbnails of pending attachments with remove buttons (iOS `AttachmentPreviewBar`). */
@Composable
fun AttachmentPreviewBar(
    attachments: List<ComposeAttachment>,
    onRemove: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (attachments.isEmpty()) return
    LazyRow(
        modifier = modifier.fillMaxWidth(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        items(attachments, key = { it.stored.id }) { attachment ->
            AttachmentThumbnail(bitmap = attachment.bitmap, onRemove = { onRemove(attachment.stored.id) })
        }
    }
}

@Composable
private fun AttachmentThumbnail(bitmap: Bitmap, onRemove: () -> Unit) {
    Box(modifier = Modifier.padding(top = 4.dp, end = 4.dp)) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(8.dp))
        )
        Icon(
            Icons.Filled.Cancel,
            contentDescription = stringResource(R.string.session_detail_remove_attachment),
            tint = Color.White,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .offset(x = 4.dp, y = (-4).dp)
                .size(20.dp)
                .clip(CircleShape)
                .background(Color.Black.copy(alpha = 0.5f))
                .clickable(onClick = onRemove)
        )
    }
}

/** Slash command suggestions above the composer (iOS `CommandSuggestionView`). */
@Composable
fun CommandSuggestions(
    groups: List<SlashCommandGroup>,
    onSelect: (SlashCommand) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (groups.isEmpty()) return
    LazyColumn(
        modifier = modifier
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .fillMaxWidth()
            .heightIn(max = 200.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(NimbalystColors.backgroundSecondary)
            .border(0.5.dp, NimbalystColors.border, RoundedCornerShape(12.dp))
    ) {
        groups.forEach { group ->
            item(key = "header-${group.source}") {
                Text(
                    text = sourceLabel(group.source).uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = NimbalystColors.textFaint,
                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 4.dp)
                )
            }
            items(group.commands, key = { "${group.source}:${it.name}" }) { command ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelect(command) }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "/${command.name}",
                        style = MaterialTheme.typography.bodyLarge,
                        fontFamily = FontFamily.Monospace,
                        color = NimbalystColors.primary
                    )
                    command.description?.takeIf { it.isNotBlank() }?.let { description ->
                        Text(
                            text = description,
                            style = MaterialTheme.typography.bodyMedium,
                            color = NimbalystColors.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(min = 0.dp).weight(1f, fill = false)
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun sourceLabel(source: String): String = when (source) {
    "project" -> stringResource(R.string.session_detail_command_source_project)
    "builtin" -> stringResource(R.string.session_detail_command_source_builtin)
    "user" -> stringResource(R.string.session_detail_command_source_user)
    "plugin" -> stringResource(R.string.session_detail_command_source_plugin)
    "" -> stringResource(R.string.session_detail_command_source_other)
    else -> source.replaceFirstChar { it.uppercase() }
}
