package com.nimbalyst.app.ui.sessionlist

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.sync.SyncedAvailableModel
import com.nimbalyst.app.ui.theme.NimbalystColors

/**
 * Which model a new session uses. Mirrors iOS `ModelPreferences`: the last model picked
 * here if the desktop still offers it, else the desktop default, else the first offered.
 */
internal fun resolveModel(available: List<SyncedAvailableModel>, lastUsed: String?, desktopDefault: String?): String? {
    if (lastUsed != null && available.any { it.id == lastUsed }) return lastUsed
    if (desktopDefault != null && available.any { it.id == desktopDefault }) return desktopDefault
    return available.firstOrNull()?.id
}

/** "claude-code:opus" -> "claude-code". */
internal fun providerFromModelId(modelId: String?): String? = modelId?.substringBefore(':')

/** The last model chosen in the picker, kept on this device like iOS. */
internal class LastUsedModel(context: Context) {
    private val prefs = context.getSharedPreferences("nimbalyst_model_prefs", Context.MODE_PRIVATE)
    fun get(): String? = prefs.getString(KEY, null)
    fun set(modelId: String) = prefs.edit().putString(KEY, modelId).apply()
    private companion object { const val KEY = "last_used_model_id" }
}

/**
 * Asked on every create: [initialModelId] (the last one used) is preselected, so
 * Create alone reuses it. Agents first, then chat models, each grouped by
 * provider (iOS `ModelPickerView`).
 */
@Composable
internal fun ModelPickerDialog(
    title: String,
    models: List<SyncedAvailableModel>,
    initialModelId: String?,
    onCreate: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var selectedModelId by rememberSaveable { mutableStateOf(initialModelId) }
    val isAgent = { m: SyncedAvailableModel -> m.provider == "claude-code" || m.provider == "openai-codex" }
    val sections: List<Pair<Int, List<SyncedAvailableModel>>> = listOf(
        R.string.model_picker_agents to models.filter(isAgent),
        R.string.model_picker_chat to models.filterNot(isAgent),
    ).filter { it.second.isNotEmpty() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            LazyColumn(modifier = Modifier.heightIn(max = 420.dp)) {
                sections.forEach { (title, sectionModels) ->
                    item(key = "h-$title") {
                        Text(
                            text = stringResource(title),
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 12.dp, bottom = 4.dp)
                        )
                    }
                    sectionModels.groupBy { it.provider }.toSortedMap().forEach { (_, providerModels) ->
                        providerModels.forEach { model ->
                            item(key = model.id) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { selectedModelId = model.id }
                                        .padding(vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(model.name, modifier = Modifier.weight(1f))
                                    if (model.id == selectedModelId) {
                                        Icon(
                                            Icons.Default.Check,
                                            contentDescription = null,
                                            tint = NimbalystColors.primary,
                                            modifier = Modifier.size(18.dp)
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { selectedModelId?.let(onCreate) }, enabled = selectedModelId != null) {
                Text(stringResource(R.string.model_picker_create))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.session_action_cancel)) } }
    )
}
