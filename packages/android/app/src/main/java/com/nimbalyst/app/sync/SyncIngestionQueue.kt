package com.nimbalyst.app.sync

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * One consumer applies socket messages in the order they arrived.
 *
 * Launching a coroutine per message hands ordering to the dispatcher, which is
 * how a session row reached Room before the snapshot carrying its project
 * (#1336), and how an older broadcast can overwrite a newer one. Mirrors iOS
 * `IndexIngestionQueue`.
 *
 * [reset] starts a new generation and drops whatever the previous one had not
 * applied: that work belongs to a connection or account that is gone, and a
 * reconnect requests the state again.
 */
internal class SyncIngestionQueue(
    private val scope: CoroutineScope,
    private val name: String,
    private val onError: (Throwable) -> Unit,
) {
    private val lock = Any()
    private var channel = Channel<suspend () -> Unit>(Channel.UNLIMITED)
    private var consumer: Job = startConsumer(channel)

    /** Enqueue work. Never suspends, so submission order is application order. */
    fun submit(work: suspend () -> Unit) {
        synchronized(lock) { channel }.trySend(work)
    }

    fun reset() {
        synchronized(lock) {
            channel.close()
            consumer.cancel()
            channel = Channel(Channel.UNLIMITED)
            consumer = startConsumer(channel)
        }
    }

    /** Suspends until everything submitted before this call has been applied. */
    suspend fun awaitIdle() {
        val done = CompletableDeferred<Unit>()
        submit { done.complete(Unit) }
        done.await()
    }

    private fun startConsumer(queue: Channel<suspend () -> Unit>): Job = scope.launch {
        for (work in queue) {
            try {
                work()
            } catch (e: CancellationException) {
                throw e
            } catch (t: Throwable) {
                // One bad message must not stop ingestion or crash the app.
                Log.e(TAG, "[$name] ingestion failed: ${t.message}", t)
                onError(t)
            }
        }
    }

    private companion object {
        const val TAG = "SyncIngestion"
    }
}
