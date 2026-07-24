package com.nimbalyst.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.sync.DeviceInfo
import com.nimbalyst.app.sync.SyncConnectionState

@Composable
fun ConnectionIndicator(
    syncState: SyncConnectionState,
    connectedDevices: List<DeviceInfo>,
    modifier: Modifier = Modifier
) {
    val hasDesktop = connectedDevices.any {
        it.platform.equals("desktop", ignoreCase = true) ||
            it.platform.equals("electron", ignoreCase = true)
    }
    val dotColor = when {
        hasDesktop -> Color(0xFF4ADE80) // green -- desktop connected
        syncState.indexConnected -> Color(0xFFFBBF24) // yellow -- server only
        else -> Color(0xFF808080) // gray -- disconnected
    }

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
    ) {
        Icon(
            imageVector = Icons.Default.Computer,
            contentDescription = "Desktop connection",
            modifier = Modifier.size(20.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Box(
            modifier = Modifier
                .padding(start = 4.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(dotColor)
        )
    }
}
