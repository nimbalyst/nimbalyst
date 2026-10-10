package com.nimbalyst.app.ui.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.R
import com.nimbalyst.app.sync.DeviceInfo
import com.nimbalyst.app.sync.ExecutionHosts
import com.nimbalyst.app.ui.theme.NimbalystColors

/** Toolbar status dot: green when the chosen machine is online, orange when only sync is up. */
internal fun computerStatusColor(selected: DeviceInfo?, syncConnected: Boolean): Color = when {
    selected != null && ExecutionHosts.isOnline(selected) -> NimbalystColors.success
    syncConnected -> NimbalystColors.warning
    else -> NimbalystColors.textDisabled
}

/**
 * The iOS computer menu: pick which desktop or headless machine the list shows and new
 * sessions run on. Offline machines are listed (their sessions stay readable) with a
 * gray dot; the sync layer refuses to create on them.
 */
@Composable
fun ComputerPicker(
    hosts: List<DeviceInfo>,
    selectedHostId: String?,
    syncConnected: Boolean,
    onSelect: (String?) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = hosts.firstOrNull { it.deviceId == selectedHostId }
    Box {
        IconButton(onClick = { expanded = true }) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(
                    Icons.Outlined.Computer,
                    contentDescription = stringResource(R.string.computer_picker_label),
                    tint = if (syncConnected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp)
                )
                Dot(computerStatusColor(selected, syncConnected))
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.computer_picker_none)) },
                trailingIcon = { if (selectedHostId == null) Check() },
                onClick = { expanded = false; onSelect(null) }
            )
            hosts.forEach { host ->
                val online = ExecutionHosts.isOnline(host)
                DropdownMenuItem(
                    leadingIcon = { Dot(if (online) NimbalystColors.success else NimbalystColors.textDisabled) },
                    text = {
                        Text(if (online) host.name else stringResource(R.string.computer_picker_offline, host.name))
                    },
                    trailingIcon = { if (host.deviceId == selectedHostId) Check() },
                    onClick = { expanded = false; onSelect(host.deviceId) }
                )
            }
            if (selectedHostId != null && selected == null) {
                DropdownMenuItem(
                    leadingIcon = { Dot(NimbalystColors.textDisabled) },
                    text = { Text(stringResource(R.string.computer_picker_remote_offline)) },
                    trailingIcon = { Check() },
                    onClick = { expanded = false }
                )
            }
        }
    }
}

@Composable
private fun Check() = Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(18.dp))

@Composable
private fun Dot(color: Color) {
    Box(
        modifier = Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
    )
}
