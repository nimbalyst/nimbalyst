package com.nimbalyst.app.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

enum class AndroidScreen(val label: String, val icon: ImageVector) {
    Projects("Projects", Icons.Default.Home),
    Sessions("Sessions", Icons.AutoMirrored.Filled.List),
    Settings("Settings", Icons.Default.Settings),
}
