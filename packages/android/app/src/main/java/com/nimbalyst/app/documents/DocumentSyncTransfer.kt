package com.nimbalyst.app.documents

sealed interface DocumentSyncState {
    data object Connecting : DocumentSyncState
    data class Syncing(val received: Int) : DocumentSyncState
    data object Ready : DocumentSyncState
    data class Failed(val message: String) : DocumentSyncState
}

sealed interface DocumentAvailability {
    /** The account, key, or project transfer is still on its way. */
    data object Waiting : DocumentAvailability
    data class Available(val document: SyncedDocument) : DocumentAvailability
    /** The project finished syncing and the file is not in it. */
    data object Missing : DocumentAvailability
    data class Failed(val message: String) : DocumentAvailability
}

/**
 * One connection's initial download. Immutable: the manager commits the value
 * [accept] returns only after the batch's database transaction succeeds, so a
 * failed write never advances the sequence. Mirrors iOS `DocumentSyncTransfer`.
 */
internal data class DocumentSyncTransfer(
    private val transferId: String? = null,
    private val nextBatch: Int = 0,
    val received: Int = 0,
    val complete: Boolean = false,
) {
    fun accept(response: ProjectSyncResponse): DocumentSyncTransfer {
        if (complete) throw invalidSequence()
        val metadata = response.metadata
        val next = if (metadata == null) {
            // A pre-batching server answers in exactly one message.
            if (nextBatch != 0) throw invalidSequence()
            copy(complete = true)
        } else {
            if (metadata.transferId.isEmpty() || metadata.batchIndex != nextBatch) throw invalidSequence()
            if (transferId != null && transferId != metadata.transferId) throw invalidSequence()
            copy(transferId = metadata.transferId, nextBatch = nextBatch + 1, complete = metadata.isLastBatch)
        }
        return next.copy(received = received + response.files.size)
    }

    private fun invalidSequence() =
        DocumentSyncException("File sync received an invalid or out-of-order batch. Please retry.")
}
