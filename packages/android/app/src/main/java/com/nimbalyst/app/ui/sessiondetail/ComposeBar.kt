package com.nimbalyst.app.ui.sessiondetail

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.PlaylistAdd
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.ArrowCircleUp
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.StopCircle
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.ui.theme.NimbalystShapes

/** What the composer's trailing button does, from iOS `ComposeBar`. */
enum class ComposeAction { Send, Queue, Stop }

internal fun composeAction(isExecuting: Boolean, canSend: Boolean): ComposeAction = when {
    isExecuting && canSend -> ComposeAction.Queue
    isExecuting -> ComposeAction.Stop
    else -> ComposeAction.Send
}

/**
 * Prompt input with slash-command typeahead, attachment previews, the "+" sheet,
 * and a Send / Queue / Stop button.
 */
@Composable
fun ComposeBar(
    text: String,
    onTextChange: (String) -> Unit,
    onFocusChanged: (Boolean) -> Unit,
    attachments: List<ComposeAttachment>,
    onRemoveAttachment: (String) -> Unit,
    isExecuting: Boolean,
    commands: List<SlashCommand>,
    hasActions: Boolean,
    onOpenActions: () -> Unit,
    onPickPhotos: () -> Unit,
    onTakePhoto: () -> Unit,
    onPaste: () -> Unit,
    onSubmit: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val focusManager = LocalFocusManager.current
    var showAddSheet by rememberSaveable { mutableStateOf(false) }
    val canSend = text.isNotBlank() || attachments.isNotEmpty()
    val suggestionGroups = remember(text, commands) {
        SlashCommandFilter.slashQuery(text)
            ?.takeIf { commands.isNotEmpty() }
            ?.let { SlashCommandFilter.filter(commands, it) }
            .orEmpty()
    }

    Column(modifier = modifier.fillMaxWidth()) {
        AnimatedVisibility(visible = suggestionGroups.isNotEmpty(), enter = fadeIn(), exit = fadeOut()) {
            CommandSuggestions(
                groups = suggestionGroups,
                onSelect = { onTextChange(SlashCommandFilter.completion(it)) }
            )
        }
        AttachmentPreviewBar(attachments = attachments, onRemove = onRemoveAttachment)
        HorizontalDivider(color = NimbalystColors.border, thickness = 0.5.dp)

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(NimbalystColors.backgroundSecondary)
                .navigationBarsPadding()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            IconButton(onClick = { showAddSheet = true }) {
                Icon(
                    Icons.Filled.AddCircle,
                    contentDescription = stringResource(R.string.session_detail_add),
                    tint = NimbalystColors.textMuted,
                    modifier = Modifier.size(28.dp)
                )
            }

            ComposeField(
                text = text,
                onTextChange = onTextChange,
                onFocusChanged = onFocusChanged,
                modifier = Modifier
                    .weight(1f)
                    .padding(vertical = 4.dp)
            )

            when (composeAction(isExecuting, canSend)) {
                ComposeAction.Queue -> IconButton(onClick = {
                    // Clear focus first so a pending IME composition commits before the field is cleared.
                    focusManager.clearFocus()
                    onSubmit()
                }) {
                    Icon(
                        Icons.AutoMirrored.Filled.PlaylistAdd,
                        contentDescription = stringResource(R.string.session_detail_queue),
                        tint = NimbalystColors.warning,
                        modifier = Modifier.size(28.dp)
                    )
                }
                ComposeAction.Stop -> IconButton(onClick = onStop) {
                    Icon(
                        Icons.Filled.StopCircle,
                        contentDescription = stringResource(R.string.session_detail_stop),
                        tint = NimbalystColors.error,
                        modifier = Modifier.size(32.dp)
                    )
                }
                ComposeAction.Send -> IconButton(
                    enabled = canSend,
                    onClick = {
                        focusManager.clearFocus()
                        onSubmit()
                    }
                ) {
                    Icon(
                        Icons.Filled.ArrowCircleUp,
                        contentDescription = stringResource(R.string.session_detail_send),
                        tint = if (canSend) NimbalystColors.primary else NimbalystColors.textDisabled,
                        modifier = Modifier.size(32.dp)
                    )
                }
            }
        }
    }

    if (showAddSheet) {
        AddSheet(
            hasActions = hasActions,
            onDismiss = { showAddSheet = false },
            onSelect = { choice ->
                showAddSheet = false
                when (choice) {
                    AddChoice.Actions -> onOpenActions()
                    AddChoice.Photos -> onPickPhotos()
                    AddChoice.Camera -> onTakePhoto()
                    AddChoice.Paste -> onPaste()
                }
            }
        )
    }
}

@Composable
private fun ComposeField(
    text: String,
    onTextChange: (String) -> Unit,
    onFocusChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val textStyle = MaterialTheme.typography.bodyLarge.copy(color = NimbalystColors.text)
    // Local selection state; text replaced from outside (command pick, remote
    // draft, restore) puts the cursor at the end.
    var fieldValue by remember { mutableStateOf(TextFieldValue(text, TextRange(text.length))) }
    if (fieldValue.text != text) {
        fieldValue = TextFieldValue(text, TextRange(text.length))
    }
    BasicTextField(
        value = fieldValue,
        onValueChange = { value ->
            fieldValue = value
            if (value.text != text) onTextChange(value.text)
        },
        textStyle = textStyle,
        cursorBrush = SolidColor(NimbalystColors.primary),
        minLines = 1,
        maxLines = 6,
        modifier = modifier
            .testTag("session-compose-input")
            .onFocusChanged { onFocusChanged(it.isFocused) },
        decorationBox = { inner ->
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(NimbalystColors.backgroundTertiary, NimbalystShapes.composer)
                    .padding(horizontal = 12.dp, vertical = 8.dp)
            ) {
                if (text.isEmpty()) {
                    Text(
                        text = stringResource(R.string.session_detail_compose_placeholder),
                        style = textStyle,
                        color = NimbalystColors.textFaint
                    )
                }
                inner()
            }
        }
    )
}

private enum class AddChoice { Actions, Photos, Camera, Paste }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddSheet(hasActions: Boolean, onDismiss: () -> Unit, onSelect: (AddChoice) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = NimbalystColors.backgroundSecondary) {
        Column(modifier = Modifier.padding(bottom = 16.dp)) {
            if (hasActions) {
                AddRow(Icons.Filled.Bolt, stringResource(R.string.session_detail_add_actions)) { onSelect(AddChoice.Actions) }
            }
            AddRow(Icons.Filled.PhotoLibrary, stringResource(R.string.session_detail_add_photo_library)) {
                onSelect(AddChoice.Photos)
            }
            AddRow(Icons.Filled.PhotoCamera, stringResource(R.string.session_detail_add_camera)) { onSelect(AddChoice.Camera) }
            AddRow(Icons.Filled.ContentPaste, stringResource(R.string.session_detail_add_paste)) { onSelect(AddChoice.Paste) }
        }
    }
}

@Composable
private fun AddRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Icon(icon, contentDescription = null, tint = NimbalystColors.textMuted)
        Text(text = label, style = MaterialTheme.typography.bodyLarge)
    }
}
