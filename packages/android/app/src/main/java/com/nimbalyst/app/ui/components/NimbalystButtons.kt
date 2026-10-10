package com.nimbalyst.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.ui.theme.NimbalystShapes

/** Filled 50dp, radius-12 button (iOS LoginView "Sign in with Google"). */
@Composable
fun NimbalystPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    leading: (@Composable RowScope.() -> Unit)? = null
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = NimbalystShapes.button,
        colors = ButtonDefaults.buttonColors(
            containerColor = NimbalystColors.primary,
            contentColor = Color.White,
            disabledContainerColor = NimbalystColors.primary.copy(alpha = 0.4f),
            disabledContentColor = Color.White.copy(alpha = 0.7f)
        ),
        modifier = modifier.fillMaxWidth().height(50.dp)
    ) {
        ButtonContent(text, loading, Color.White, leading)
    }
}

/** Outlined 50dp, radius-12 button (iOS LoginView "Sign in with email link"). */
@Composable
fun NimbalystSecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = NimbalystShapes.button,
        border = BorderStroke(1.5.dp, NimbalystColors.primary.copy(alpha = if (enabled) 1f else 0.4f)),
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = NimbalystColors.primary,
            disabledContentColor = NimbalystColors.primary.copy(alpha = 0.5f)
        ),
        modifier = modifier.fillMaxWidth().height(50.dp)
    ) {
        ButtonContent(text, loading, NimbalystColors.primary, null)
    }
}

@Composable
private fun ButtonContent(
    text: String,
    loading: Boolean,
    spinnerColor: Color,
    leading: (@Composable RowScope.() -> Unit)?
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = spinnerColor
            )
        } else {
            leading?.invoke(this)
        }
        Text(text = text, style = MaterialTheme.typography.labelLarge)
    }
}
