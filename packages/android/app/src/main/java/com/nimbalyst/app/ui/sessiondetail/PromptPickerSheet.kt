package com.nimbalyst.app.ui.sessiondetail

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.transcript.TranscriptPrompt
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.utils.RelativeTimestamp

/** Searchable list of the transcript's user prompts (iOS `PromptPickerList`). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromptPickerSheet(
    prompts: List<TranscriptPrompt>,
    onSelect: (TranscriptPrompt) -> Unit,
    onDismiss: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val numbered = remember(prompts) { prompts.mapIndexed { i, p -> (i + 1) to p } }
    val filtered = if (query.isBlank()) numbered else numbered.filter { (_, p) ->
        p.text.contains(query, ignoreCase = true)
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
                    text = stringResource(R.string.session_detail_jump_to_prompt),
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
                placeholder = { Text(stringResource(R.string.session_detail_prompt_picker_search)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            )
            if (filtered.isEmpty() && query.isNotBlank()) {
                Text(
                    text = stringResource(R.string.session_detail_prompt_picker_no_results, query),
                    style = MaterialTheme.typography.bodyMedium,
                    color = NimbalystColors.textMuted,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp)
                )
            }
            LazyColumn(modifier = Modifier.fillMaxWidth()) {
                items(filtered, key = { (number, _) -> number }) { (number, prompt) ->
                    PromptRow(number = number, prompt = prompt, onClick = { onSelect(prompt) })
                }
            }
        }
    }
}

@Composable
private fun PromptRow(number: Int, prompt: TranscriptPrompt, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = stringResource(R.string.session_detail_prompt_number, number),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = NimbalystColors.primary,
            textAlign = TextAlign.End,
            modifier = Modifier.widthIn(min = 30.dp)
        )
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = prompt.text.ifBlank { stringResource(R.string.session_detail_prompt_fallback, number) },
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
            if (prompt.createdAt > 0) {
                Text(
                    text = RelativeTimestamp.format(prompt.createdAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = NimbalystColors.textMuted
                )
            }
        }
    }
}
