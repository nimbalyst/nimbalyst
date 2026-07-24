package com.nimbalyst.app.utils

import java.text.DateFormat
import java.util.Date

object RelativeTimestamp {
    fun format(epochMs: Long): String {
        val now = System.currentTimeMillis()
        val seconds = ((now - epochMs) / 1000).toInt()

        return when {
            seconds < 0 -> "now"
            seconds < 60 -> "now"
            seconds < 3600 -> "${seconds / 60}m ago"
            seconds < 86400 -> "${seconds / 3600}h ago"
            seconds < 604800 -> "${seconds / 86400}d ago"
            else -> DateFormat.getDateInstance(DateFormat.SHORT).format(Date(epochMs))
        }
    }
}
