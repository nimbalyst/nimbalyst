package com.nimbalyst.app.ui.sessionlist

import com.nimbalyst.app.sync.IndexCoverage
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged

/** What to say about a search while index history is not known to be complete (iOS `incompleteHistoryDescription`). */
enum class SearchCoverageNotice { NONE, SYNCING, FAILED, LEGACY_SERVER }

object SessionListSearch {
    const val DEBOUNCE_MS = 250L

    /** The query the list filters by: typing settles for [DEBOUNCE_MS] first; clearing applies at once. */
    @OptIn(FlowPreview::class)
    fun debounced(typed: Flow<String>): Flow<String> =
        typed.debounce { if (it.isBlank()) 0L else DEBOUNCE_MS }.distinctUntilChanged()

    /** Until history is complete, a search result (even an empty one) is not the whole answer. */
    fun coverageNotice(isSearching: Boolean, coverage: IndexCoverage): SearchCoverageNotice = when {
        !isSearching || coverage.historyComplete -> SearchCoverageNotice.NONE
        coverage.hasError -> SearchCoverageNotice.FAILED
        coverage.compatibility == IndexCoverage.Compatibility.LEGACY_SERVER -> SearchCoverageNotice.LEGACY_SERVER
        else -> SearchCoverageNotice.SYNCING
    }
}
