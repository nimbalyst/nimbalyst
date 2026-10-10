package com.nimbalyst.app.documents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DocumentSyncTransferTest {
    private fun response(metadata: String?, newFiles: Int = 0): ProjectSyncResponse {
        val files = (0 until newFiles).joinToString(",") { i ->
            """{"syncId":"f$i","encryptedContent":"c","contentIv":"i","contentHash":"h","encryptedPath":"p","pathIv":"i","encryptedTitle":"t","titleIv":"i","lastModifiedAt":1,"hasYjs":false}"""
        }
        val meta = metadata?.let { ",$it" } ?: ""
        return ProjectSyncResponse.parse(
            """{"type":"projectSyncResponse","updatedFiles":[],"newFiles":[$files],"yjsUpdates":[],"needFromClient":[],"deletedSyncIds":[]$meta}"""
        )
    }

    @Test
    fun batchesCompleteOnlyOnTheLastInSequence() {
        var transfer = DocumentSyncTransfer()
        transfer = transfer.accept(response(""""transferId":"t","batchIndex":0,"isLastBatch":false""", newFiles = 2))
        assertFalse(transfer.complete)
        assertEquals(2, transfer.received)
        transfer = transfer.accept(response(""""transferId":"t","batchIndex":1,"isLastBatch":true""", newFiles = 1))
        assertTrue(transfer.complete)
        assertEquals(3, transfer.received)
    }

    @Test
    fun legacyResponseWithoutMetadataCompletesInOne() {
        val transfer = DocumentSyncTransfer().accept(response(null))
        assertTrue(transfer.complete)
    }

    @Test
    fun outOfOrderWrongTransferAndPartialMetadataAreRejected() {
        val invalid = listOf(
            """"transferId":"t","batchIndex":1,"isLastBatch":true""",
            """"transferId":"t","batchIndex":-1,"isLastBatch":true""",
            """"transferId":"","batchIndex":0,"isLastBatch":true""",
        )
        for (meta in invalid) {
            try {
                DocumentSyncTransfer().accept(response(meta))
                fail("accepted $meta")
            } catch (_: DocumentSyncException) {
            }
        }
        val first = DocumentSyncTransfer().accept(response(""""transferId":"a","batchIndex":0,"isLastBatch":false"""))
        try {
            first.accept(response(""""transferId":"b","batchIndex":1,"isLastBatch":true"""))
            fail("accepted a batch from another transfer")
        } catch (_: DocumentSyncException) {
        }
        val done = DocumentSyncTransfer().accept(response(null))
        try {
            done.accept(response(null))
            fail("accepted a batch after completion")
        } catch (_: DocumentSyncException) {
        }
        try {
            DocumentSyncTransfer()
                .accept(response(""""transferId":"a","batchIndex":0,"isLastBatch":false"""))
                .accept(response(null))
            fail("a legacy response cannot continue a batched transfer")
        } catch (_: DocumentSyncException) {
        }
    }

    @Test
    fun partialOrNullMetadataIsMalformedNotLegacy() {
        for (meta in listOf(""""transferId":"t"""", """"transferId":null,"batchIndex":null,"isLastBatch":null""")) {
            try {
                response(meta)
                fail("parsed $meta")
            } catch (_: DocumentSyncException) {
            }
        }
        assertNull(response(null).metadata)
    }
}
