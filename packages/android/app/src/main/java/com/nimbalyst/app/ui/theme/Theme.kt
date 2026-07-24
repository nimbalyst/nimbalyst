package com.nimbalyst.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val NimbalystDarkColors = darkColorScheme()

@Composable
fun NimbalystAndroidTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = NimbalystDarkColors,
        typography = MaterialTheme.typography,
        content = content
    )
}

