package com.nimbalyst.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Tracks the screens that show document save failures themselves (the file
 * list and the editor), so the shell shows its app-level banner only when
 * neither is on screen, e.g. after a sign-out. Main thread only.
 */
object DocumentSurfaces {
    private var visibleCount by mutableIntStateOf(0)

    /**
     * A document surface was shown in this process. Save failures only come
     * from those surfaces, so until then the shell does not create the
     * document manager (and its connections) just to watch for them.
     */
    var everShown by mutableStateOf(false)
        private set

    val isVisible: Boolean get() = visibleCount > 0

    fun enter() {
        visibleCount++
        everShown = true
    }

    fun exit() {
        visibleCount = (visibleCount - 1).coerceAtLeast(0)
    }
}

/** Marks a document surface as on screen for as long as this is composed. */
@Composable
fun DocumentSurfaceMarker() {
    DisposableEffect(Unit) {
        DocumentSurfaces.enter()
        onDispose { DocumentSurfaces.exit() }
    }
}
