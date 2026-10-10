package com.nimbalyst.app.sync

import android.util.Log
import com.google.gson.Gson
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.IndexReplicationStore
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.SessionEntity
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Drives versioned index replication for one index connection: the
 * recent-first seed (which doubles as the compatibility probe), the bootstrap,
 * delta catch-up, and navigation lookups. Port of iOS `IndexReplicationClient`.
 *
 * Every method runs inside the index [SyncIngestionQueue], so pages, hints,
 * lookups and timeouts are handled one at a time in order and this class needs
 * no locks. One request is in flight at a time; navigation lookups take the
 * next slot ahead of history fill.
 */
internal class IndexReplicationClient(
    private val gson: Gson,
    private val store: IndexReplicationStore,
    private val repository: NimbalystRepository,
    private val decoder: SessionEntryDecoder,
    private val crypto: () -> CryptoManager?,
    private val send: (String) -> Boolean,
    private val coverage: MutableStateFlow<IndexCoverage>,
    private val scope: CoroutineScope,
    /** Re-enters the ingestion queue, for timeouts. */
    private val submit: (suspend () -> Unit) -> Unit,
    /** Called after a page commits, with the rows it committed; a rejected revision is not among them. */
    private val onApplied: suspend (previous: Map<String, SessionEntity>, committed: List<SessionEntity>) -> Unit,
    /** Called once a bootstrap's reconciliation commits, with the run's readability. */
    private val onBootstrapFinalized: (IndexReplicationStore.Finalization) -> Unit = {},
    /** The server predates v2: fall back to the legacy full index. */
    private val onLegacyServer: () -> Unit,
    private val onTimeout: () -> Unit = {},
    private val timeoutMs: Long = REQUEST_TIMEOUT_MS,
) {
    private data class InFlight(
        val requestId: String,
        val mode: IndexReplicationMode,
        val lookupIds: List<String>?,
        /** The connection's first request; only its unknown_message_type proves a pre-v2 server. */
        val isProbe: Boolean,
    )

    private sealed interface BootstrapContinuation {
        data object Start : BootstrapContinuation
        data class Page(val token: String) : BootstrapContinuation
    }

    private var inFlight: InFlight? = null
    private var timeoutJob: Job? = null
    private var cancelled = false
    private var seedApplied = false
    private var hasChosenCoverageWork = false
    private var bootstrapRunId: String? = null
    private var bootstrapContinuation: BootstrapContinuation? = null
    private var lookupContinuation: Pair<String, List<String>>? = null
    private val pendingLookupIds = ArrayList<String>()
    private var ancestorHops = 0
    private var backgrounded = false
    /** The highest revision the server has announced, kept across phases. */
    private var highestHintedRevision = 0L

    private val owesDelta: Boolean get() = highestHintedRevision > (coverage.value.lastCommittedRevision ?: 0L)

    /** Begins replication for a fresh connection: loads coverage, resumes an interrupted bootstrap, sends the seed. */
    suspend fun start() {
        if (cancelled) return
        seedApplied = false
        hasChosenCoverageWork = false
        coverage.update { it.copy(hasError = false) }
        store.pendingFinalization()?.let { pending ->
            // An interrupted bootstrap owes reconciliation before anything new.
            coverage.update { it.copy(isBackfilling = true) }
            runCatching { store.finalizeBootstrap(pending.runId) }
                .onSuccess(onBootstrapFinalized)
                .onFailure { e -> Log.e(TAG, "Bootstrap finalization failed", e); coverage.update { it.copy(hasError = true) } }
            coverage.update { it.copy(isBackfilling = false) }
        }
        loadCoverage()
        request(IndexReplicationMode.RECENT, isProbe = true)
    }

    /**
     * Fetches these sessions (and their ancestors) whatever history has paged
     * in. Coalesced: an id already queued or in flight is not requested twice.
     * Never advances the cursor.
     */
    fun lookup(sessionIds: List<String>) {
        if (cancelled || sessionIds.isEmpty()) return
        val requested = inFlight?.lookupIds.orEmpty().toSet()
        var added = false
        for (id in sessionIds) if (id !in pendingLookupIds && id !in requested) { pendingLookupIds += id; added = true }
        while (pendingLookupIds.size > MAX_PENDING_LOOKUPS) pendingLookupIds.removeAt(0)
        if (added) ancestorHops = 0
        pumpNextRequest()
    }

    /** History fill pauses in the background; lookups and deltas still run. */
    fun setForeground(foreground: Boolean) {
        if (cancelled) return
        backgrounded = !foreground
        if (foreground) pumpNextRequest()
    }

    fun cancel() {
        cancelled = true
        timeoutJob?.cancel()
        inFlight = null
        pendingLookupIds.clear()
        bootstrapContinuation = null
        lookupContinuation = null
    }

    /** Returns false for a page this client is not waiting on (a retired generation's, or a duplicate). */
    suspend fun handlePage(response: IndexPageResponse): Boolean {
        val current = inFlight?.takeIf { it.requestId == response.requestId } ?: return false
        clearTimeout()
        val crypto = crypto() ?: run { inFlight = null; return true }
        val previous = repository.getSessions(response.entries.mapNotNull { it.session?.sessionId })
        val validated = IndexPageValidator.validate(response, current.requestId, current.mode, crypto, decoder, previous)
        inFlight = null
        val page = validated.getOrElse { error ->
            Log.e(TAG, "Index page refused (${current.mode.wire}): ${error.message}")
            coverage.update { it.copy(isBackfilling = false, hasError = true) }
            return true
        }
        if (page.resetRequired) {
            Log.i(TAG, "Server rejected the index cursor; bootstrapping again")
            store.resetReplicationEpoch()
            bootstrapRunId = null
            hasChosenCoverageWork = false
            coverage.update { it.copy(historyComplete = false, lastCommittedRevision = null) }
            startBootstrap()
            return true
        }
        val result = try {
            apply(page, current)
        } catch (e: Exception) {
            // Nothing advanced; the next hint or reconnect asks for the same range.
            Log.e(TAG, "Index page failed to apply (${current.mode.wire})", e)
            coverage.update { it.copy(isBackfilling = false, hasError = true) }
            return true
        }
        onApplied(previous, result.committedSessions)
        coverage.update {
            it.copy(compatibility = IndexCoverage.Compatibility.V2, hasError = false, skippedRowCount = store.skippedRowCount())
        }
        advanceAfter(page, current)
        return true
    }

    fun handleChangesAvailable(revision: Long) {
        if (cancelled) return
        highestHintedRevision = maxOf(highestHintedRevision, revision)
        requestDeltaIfNeeded()
    }

    /** Returns true when the error answered this client's request. */
    fun handleError(code: String, requestId: String?): Boolean {
        val current = inFlight ?: return false
        if (requestId != null && requestId != current.requestId) return false
        val provesLegacy = code == "unknown_message_type" && requestId == null && current.isProbe
        // An error without a requestId answers some other message.
        if (requestId == null && !provesLegacy) return false
        clearTimeout()
        inFlight = null
        if (provesLegacy) {
            Log.i(TAG, "Server does not support versioned index replication; using legacy sync")
            coverage.update { it.copy(compatibility = IndexCoverage.Compatibility.LEGACY_SERVER, isBackfilling = false) }
            onLegacyServer()
            return true
        }
        Log.e(TAG, "Index page request failed with $code")
        coverage.update { it.copy(isBackfilling = false, hasError = true) }
        return true
    }

    private suspend fun apply(page: ValidatedIndexPage, current: InFlight): IndexReplicationStore.PageResult {
        val isBootstrap = current.mode == IndexReplicationMode.BOOTSTRAP
        val terminal = isBootstrap && page.complete
        val result = store.apply(
            page.write.copy(
                bootstrapRunId = if (isBootstrap) bootstrapRunId else null,
                commitCursor = if (terminal) null else page.committableCursor,
                beginFinalization = if (terminal) page.committableCursor else null
            )
        )
        val runId = bootstrapRunId
        if (terminal && runId != null) {
            val finalization = store.finalizeBootstrap(runId)
            if (finalization.removed > 0) {
                Log.i(TAG, "Bootstrap reconciliation removed ${finalization.removed} cached sessions absent from proven coverage")
            }
            onBootstrapFinalized(finalization)
        }
        return result
    }

    private suspend fun advanceAfter(page: ValidatedIndexPage, current: InFlight) {
        page.committableCursor?.let { cursor -> coverage.update { it.copy(lastCommittedRevision = cursor) } }
        when (current.mode) {
            IndexReplicationMode.RECENT -> {
                seedApplied = true
                advanceCoverageIfReady()
            }
            IndexReplicationMode.BOOTSTRAP -> when {
                page.complete -> {
                    coverage.update { it.copy(historyComplete = true, isBackfilling = false) }
                    bootstrapRunId = null
                    bootstrapContinuation = null
                    requestDeltaIfNeeded()
                }
                page.nextPageToken != null -> {
                    // Held, not sent: a lookup takes this slot, and backgrounding pauses here.
                    bootstrapContinuation = BootstrapContinuation.Page(page.nextPageToken)
                    pumpNextRequest()
                }
                else -> coverage.update { it.copy(isBackfilling = false) }
            }
            IndexReplicationMode.DELTA ->
                if (!page.complete && page.nextPageToken != null) {
                    request(IndexReplicationMode.DELTA, pageToken = page.nextPageToken)
                } else {
                    pumpNextRequest()
                }
            IndexReplicationMode.LOOKUP -> {
                val ids = current.lookupIds.orEmpty()
                when {
                    // A lookup is paged by bytes too; keep the original ids for the ancestor pass.
                    !page.complete && page.nextPageToken != null -> {
                        lookupContinuation = page.nextPageToken to ids
                        pumpNextRequest()
                    }
                    ancestorHops < MAX_ANCESTOR_HOPS -> {
                        ancestorHops++
                        // A session opened from a notification should arrive with its workstream.
                        store.missingAncestors(ids).forEach { if (it !in pendingLookupIds) pendingLookupIds += it }
                        pumpNextRequest()
                    }
                    else -> pumpNextRequest()
                }
            }
        }
    }

    private suspend fun loadCoverage() {
        val state = store.cursorState()
        coverage.update {
            it.copy(
                historyComplete = state.historyComplete,
                lastCommittedRevision = state.cursor.takeIf { c -> c > 0 },
                skippedRowCount = store.skippedRowCount()
            )
        }
    }

    /** Navigation first, then history fill, then catch-up. A no-op while a request is in flight. */
    private fun pumpNextRequest() {
        if (cancelled || inFlight != null) return
        lookupContinuation?.let { (token, ids) ->
            lookupContinuation = null
            request(IndexReplicationMode.LOOKUP, pageToken = token, sessionIds = ids)
            return
        }
        if (pendingLookupIds.isNotEmpty()) {
            val ids = pendingLookupIds.take(LOOKUP_BATCH)
            repeat(ids.size) { pendingLookupIds.removeAt(0) }
            request(IndexReplicationMode.LOOKUP, sessionIds = ids)
            return
        }
        val continuation = bootstrapContinuation
        if (continuation != null && !backgrounded) {
            bootstrapContinuation = null
            coverage.update { it.copy(isBackfilling = true) }
            request(IndexReplicationMode.BOOTSTRAP, pageToken = (continuation as? BootstrapContinuation.Page)?.token)
            return
        }
        // A lookup that took the slot after the seed must not strand coverage:
        // with no hint coming, this is the only thing that fetches what
        // changed while the phone was offline.
        if (seedApplied && !hasChosenCoverageWork) advanceCoverageIfReady() else requestDeltaIfNeeded()
    }

    private fun startBootstrap() {
        scheduleBootstrap()
        pumpNextRequest()
    }

    /** Marks a bootstrap owed without discarding a saved page. */
    private fun scheduleBootstrap() {
        hasChosenCoverageWork = true
        bootstrapRunId = bootstrapRunId ?: UUID.randomUUID().toString()
        if (bootstrapContinuation == null) bootstrapContinuation = BootstrapContinuation.Start
    }

    private fun advanceCoverageIfReady() {
        if (cancelled || !seedApplied || inFlight != null || hasChosenCoverageWork) return
        if (pendingLookupIds.isNotEmpty()) return pumpNextRequest()
        if (coverage.value.historyComplete) {
            hasChosenCoverageWork = true
            request(IndexReplicationMode.DELTA, sinceRevision = coverage.value.lastCommittedRevision ?: 0)
        } else {
            startBootstrap()
        }
    }

    /**
     * A delta is legitimate only once a bootstrap proved coverage; otherwise a
     * hint after a failed bootstrap would ask for changes since 0 and treat the
     * answer as a baseline it never fetched. Then the answer is to bootstrap.
     */
    private fun requestDeltaIfNeeded() {
        if (cancelled || inFlight != null || !owesDelta) return
        if (!coverage.value.historyComplete) {
            if (seedApplied && bootstrapContinuation == null) {
                scheduleBootstrap()
                if (!backgrounded) pumpNextRequest()
            }
            return
        }
        request(IndexReplicationMode.DELTA, sinceRevision = coverage.value.lastCommittedRevision ?: 0)
    }

    private fun request(
        mode: IndexReplicationMode,
        pageToken: String? = null,
        sinceRevision: Long? = null,
        sessionIds: List<String>? = null,
        isProbe: Boolean = false,
    ) {
        if (cancelled || inFlight != null) return
        val requestId = UUID.randomUUID().toString()
        val json = gson.toJson(
            IndexPageRequest(
                requestId = requestId,
                mode = mode.wire,
                pageToken = pageToken,
                // A continuation carries its own position; the server rejects both.
                sinceRevision = sinceRevision.takeIf { pageToken == null },
                sessionIds = sessionIds.takeIf { pageToken == null },
                limit = if (mode == IndexReplicationMode.RECENT) RECENT_PAGE_LIMIT else null
            )
        )
        inFlight = InFlight(requestId, mode, sessionIds, isProbe)
        startTimeout(requestId)
        if (!send(json)) {
            // The socket is gone; the next connect starts a new client.
            clearTimeout()
            inFlight = null
        }
    }

    private fun startTimeout(requestId: String) {
        timeoutJob?.cancel()
        timeoutJob = scope.launch {
            delay(timeoutMs)
            submit {
                if (inFlight?.requestId != requestId) return@submit
                // A silent server is a failure, never evidence of an old one.
                Log.e(TAG, "Index page request timed out")
                inFlight = null
                coverage.update {
                    it.copy(
                        isBackfilling = false,
                        hasError = true,
                        compatibility = if (it.compatibility == IndexCoverage.Compatibility.UNKNOWN) {
                            IndexCoverage.Compatibility.UNSUPPORTED
                        } else {
                            it.compatibility
                        }
                    )
                }
                onTimeout()
            }
        }
    }

    private fun clearTimeout() {
        timeoutJob?.cancel()
        timeoutJob = null
    }

    companion object {
        const val REQUEST_TIMEOUT_MS = 30_000L
        const val RECENT_PAGE_LIMIT = 100
        const val LOOKUP_BATCH = 50
        const val MAX_PENDING_LOOKUPS = 200
        const val MAX_ANCESTOR_HOPS = 5
        private const val TAG = "IndexReplication"
    }
}
