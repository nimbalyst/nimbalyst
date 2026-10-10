package com.nimbalyst.app.ui.theme

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver

/**
 * Material roles mapped onto [NimbalystColors] so screens that read
 * `MaterialTheme.colorScheme` pick up the Nimbalyst palette. Screens sit on
 * `backgroundSecondary` (1A1A1A); cards and grouped rows step up through the
 * surface containers, like iOS's inset-grouped lists.
 */
internal val NimbalystColorScheme = darkColorScheme(
    primary = NimbalystColors.primary,
    onPrimary = Color.White,
    primaryContainer = NimbalystColors.primary.copy(alpha = 0.18f).compositeOver(NimbalystColors.background),
    onPrimaryContainer = NimbalystColors.primary,
    inversePrimary = NimbalystColors.primary,
    secondary = NimbalystColors.textMuted,
    onSecondary = NimbalystColors.backgroundSecondary,
    secondaryContainer = NimbalystColors.backgroundTertiary,
    onSecondaryContainer = NimbalystColors.text,
    tertiary = NimbalystColors.purple,
    onTertiary = NimbalystColors.backgroundSecondary,
    tertiaryContainer = NimbalystColors.purple.copy(alpha = 0.18f).compositeOver(NimbalystColors.background),
    onTertiaryContainer = NimbalystColors.purple,
    background = NimbalystColors.backgroundSecondary,
    onBackground = NimbalystColors.text,
    surface = NimbalystColors.backgroundSecondary,
    onSurface = NimbalystColors.text,
    surfaceVariant = NimbalystColors.backgroundTertiary,
    onSurfaceVariant = NimbalystColors.textMuted,
    surfaceTint = Color.Transparent,
    inverseSurface = NimbalystColors.text,
    inverseOnSurface = NimbalystColors.backgroundSecondary,
    error = NimbalystColors.error,
    onError = Color.White,
    errorContainer = NimbalystColors.error.copy(alpha = 0.15f).compositeOver(NimbalystColors.background),
    onErrorContainer = NimbalystColors.error,
    outline = NimbalystColors.border,
    outlineVariant = NimbalystColors.backgroundTertiary,
    scrim = Color.Black,
    surfaceBright = NimbalystColors.backgroundActive,
    surfaceDim = NimbalystColors.backgroundSecondary,
    surfaceContainerLowest = NimbalystColors.backgroundSecondary,
    surfaceContainerLow = NimbalystColors.background,
    surfaceContainer = NimbalystColors.background,
    surfaceContainerHigh = NimbalystColors.backgroundTertiary,
    surfaceContainerHighest = NimbalystColors.backgroundActive
)

@Composable
fun NimbalystAndroidTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = NimbalystColorScheme,
        typography = NimbalystTypography,
        shapes = NimbalystMaterialShapes
    ) {
        // Dark-only, like iOS. The XML theme paints the same window background,
        // so there is no light flash before the first frame.
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
            content = content
        )
    }
}
