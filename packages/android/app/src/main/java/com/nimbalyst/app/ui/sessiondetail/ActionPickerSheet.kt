package com.nimbalyst.app.ui.sessiondetail

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.sync.SyncedActionPrompt
import com.nimbalyst.app.ui.theme.NimbalystColors

/** Action prompts from the desktop workspace's ai-actions.md (iOS `ActionPromptPickerView`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActionPickerSheet(
    actions: List<SyncedActionPrompt>,
    onSelect: (SyncedActionPrompt) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val needle = query.trim()
    val filtered = if (needle.isEmpty()) actions else actions.filter {
        it.label.contains(needle, ignoreCase = true) || it.body.contains(needle, ignoreCase = true)
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = NimbalystColors.backgroundSecondary) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = stringResource(R.string.session_detail_actions_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f)
                )
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.session_detail_cancel)) }
            }
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                placeholder = { Text(stringResource(R.string.session_detail_actions_filter)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            )
            if (filtered.isEmpty()) {
                Text(
                    text = stringResource(
                        if (actions.isEmpty()) R.string.session_detail_actions_empty else R.string.session_detail_actions_no_match
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = NimbalystColors.textMuted,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp)
                )
            }
            LazyColumn(modifier = Modifier.fillMaxWidth()) {
                items(filtered, key = { it.id }) { action ->
                    ActionRow(action = action, onClick = { onSelect(action) })
                }
            }
        }
    }
}

@Composable
private fun ActionRow(action: SyncedActionPrompt, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .testTag("action-prompt-${action.id}")
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(text = action.label, style = MaterialTheme.typography.bodyLarge, color = NimbalystColors.text)
            if (action.launchesNewSession) {
                Icon(
                    Icons.AutoMirrored.Filled.OpenInNew,
                    contentDescription = null,
                    tint = NimbalystColors.textFaint,
                    modifier = Modifier.size(14.dp)
                )
            }
        }
        // Launchers describe what picking them does; others preview the text that lands in the composer.
        val preview = when {
            action.launchesNewSession && action.model != null ->
                stringResource(R.string.session_detail_action_opens_session_model, action.model)
            action.launchesNewSession -> stringResource(R.string.session_detail_action_opens_session)
            else -> action.body.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        }
        Text(
            text = preview,
            style = MaterialTheme.typography.bodyMedium,
            color = NimbalystColors.textMuted,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )
    }
}
