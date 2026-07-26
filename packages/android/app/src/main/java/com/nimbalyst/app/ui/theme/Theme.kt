package com.nimbalyst.app.ui.theme

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

private val NimbalystDarkColors = darkColorScheme()

@Composable
fun NimbalystAndroidTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = NimbalystDarkColors,
        typography = MaterialTheme.typography
    ) {
        // The XML theme is DayNight, so on a light-mode device the window
        // background shows through as white wherever a screen doesn't paint.
        // The app is dark-only, so pin the background here.
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
            content = content
        )
    }
}

