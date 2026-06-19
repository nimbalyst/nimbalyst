package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.pairing.PairingStore
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * GATED sync verification harness for the Android [SyncManager].
 *
 * These tests drive the REAL [SyncManager] public API against a LIVE
 * `nimbalyst-collab` Durable-Object sync server (index room + per-session
 * room). They are NOT instrumented tests on purpose: they are plain JVM
 * (Robolectric) tests so the gating can read host environment variables and
 * check for the sibling collab-server checkout, giving a clean self-skip when
 * the server is not available.
 *
 * ## Gating model (mirrors the electron collab specs)
 *
 * This mirrors EXACTLY the `RUN_COLLAB_TESTS=1` / `COLLAB_SERVER_PATH` model
 * documented in `.github/workflows/ci.yml` for the electron
 * `tracker-sync-collab.spec.ts` / `tracker-content-collab.spec.ts` specs, and
 * the `test.skip(() => !process.env.RUN_COLLAB_TESTS, ...)` gate those specs
 * use. The `nimbalyst-collab` repo is a SEPARATE project that is not checked
 * out here, so by default every test in this class is reported as SKIPPED (via
 * JUnit's [assumeTrue] -> `AssumptionViolatedException`, which Robolectric
 * reports as skipped, not passed and not failed). CI therefore stays green.
 *
 * A test runs ONLY when BOTH of these hold:
 *   1. `RUN_COLLAB_TESTS == "1"` in the environment, AND
 *   2. the collab-server directory exists: `COLLAB_SERVER_PATH` if set,
 *      otherwise the default sibling path `../nimbalyst-collab`. A relative path
 *      is located by walking up from the gradle working directory (whose depth
 *      varies by gradle version), so a correctly-placed sibling checkout is
 *      found regardless of the exact module working directory.
 *
 * ## Required environment when un-gated (live run)
 *
 * A live [SyncManager] run needs a real authenticated, paired credential — the
 * same shape the desktop hands the mobile app at pairing time. The future
 * live harness supplies these via the environment:
 *   - `COLLAB_WS_URL`        WebSocket base URL of the running collab server
 *                            (e.g. `ws://127.0.0.1:8787`). Defaults to
 *                            `ws://127.0.0.1:8787` — ADJUST to match the
 *                            nimbalyst-collab dev server's actual port.
 *   - `COLLAB_AUTH_JWT`      a valid (team-scoped) session JWT the server's
 *                            room auth will accept.
 *   - `COLLAB_SESSION_TOKEN` Stytch session token used for JWT refresh.
 *   - `COLLAB_ENCRYPTION_SEED` E2E encryption seed (must match the seed the
 *                            desktop used so payloads decrypt).
 *   - `COLLAB_AUTH_USER_ID`  auth/crypto user id (JWT `sub`); also used to
 *                            derive the AES key.
 *   - `COLLAB_ORG_ID`        org id used to build the room id
 *                            (`org:<org>:user:<user>:index`).
 *
 * ## Scaffolding status
 *
 * The join/submit calls below are REAL public-API calls against the live
 * server — `connect()`, `requestFullSync()`, `joinSessionRoom()`,
 * `sendPrompt()`, `sendSessionControlMessage()`. The assertions on the live
 * round-trip results are intentionally minimal and TODO-marked: they confirm
 * the connection/submit succeeded and are meant to be fleshed out (assert on
 * the decrypted snapshot contents, broadcast echo, server ack, etc.) once a
 * live server + fixture data are wired up by the future harness.
 *
 * These tests are deliberately NOT vacuous when un-gated: each awaits a real
 * state transition inside [withTimeout]. If the server is unreachable (or the
 * supplied credentials are rejected) the awaited [kotlinx.coroutines.flow.StateFlow]
 * condition never flips, the timeout throws, and the test FAILS loudly rather
 * than passing without having proven anything.
 *
 * ## Local run recipe
 *
 * See `packages/android/TESTING.md` -> "Sync verification (gated)" for the full
 * recipe (clone the sibling repo, start its dev server, set the env vars, run
 * just this class).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class SyncCollabIntegrationTest {

    private lateinit var db: NimbalystDatabase
    private lateinit var repository: NimbalystRepository
    private lateinit var pairingStore: PairingStore
    private lateinit var notificationManager: NotificationManager
    private lateinit var scope: CoroutineScope
    private lateinit var syncManager: SyncManager

    @Before
    fun setUp() {
        // GATE FIRST, before constructing any collaborator. assumeTrue throws
        // AssumptionViolatedException when its condition is false, which JUnit /
        // Robolectric report as SKIPPED. Nothing below this point runs when the
        // collab server is unavailable, so CI is never affected.
        assumeTrue(
            "Skipping gated sync verification: set RUN_COLLAB_TESTS=1 and provide a " +
                "nimbalyst-collab checkout (COLLAB_SERVER_PATH or sibling ../nimbalyst-collab).",
            collabTestsEnabled()
        )

        val context = ApplicationProvider.getApplicationContext<android.content.Context>()

        // Real Room stack (in-memory) — same pattern as NimbalystDaoTest. We use
        // the in-memory builder so the seed onCreate callback does not run and
        // the DB starts empty.
        db = Room.inMemoryDatabaseBuilder(context, NimbalystDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        repository = NimbalystRepository(db)

        // Real collaborators. NotificationManager stays inert here (no Firebase
        // config in the test environment), which is fine — SyncManager only
        // reads notificationManager.state.value.deviceToken on connect.
        notificationManager = NotificationManager(context)

        // Real PairingStore seeded from env-provided credentials. This is the
        // exact credential shape the desktop hands the mobile app at pairing
        // time; the live harness provides the values.
        pairingStore = PairingStore(context)
        pairingStore.savePairing(liveCredentialsFromEnv())

        // Real-thread scope (NOT runTest's virtual clock) — okhttp WebSocket
        // callbacks fire on real background threads and would not advance a
        // virtual test dispatcher.
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        syncManager = SyncManager(
            context = context,
            repository = repository,
            pairingStore = pairingStore,
            notificationManager = notificationManager,
            scope = scope
        )
    }

    @After
    fun tearDown() {
        if (::syncManager.isInitialized) {
            syncManager.disconnect()
        }
        if (::scope.isInitialized) {
            scope.cancel()
        }
        if (::db.isInitialized) {
            db.close()
        }
    }

    /**
     * Unit-returning wrapper around [runBlocking].
     *
     * JUnit4 requires `@Test` methods to return void/Unit, and that is validated
     * at runner-construction time (before `@Before` / `assumeTrue`), so a
     * non-Unit return would fail class initialization and report as FAILED
     * instead of SKIPPED — defeating the gating. A bare `runBlocking { ... }`
     * expression body returns whatever its last expression evaluates to (e.g.
     * `SyncConnectionState`), which is exactly that foot-gun. This wrapper forces
     * the return type to Unit no matter how a test body ends.
     */
    private fun runBlockingTest(block: suspend CoroutineScope.() -> Unit) {
        runBlocking(block = block)
    }

    // ---------------------------------------------------------------------
    // Index room: join + receive index snapshot
    // ---------------------------------------------------------------------

    @Test
    fun `index room joins and receives an index snapshot`() = runBlockingTest {
        // Real public-API call: connect() builds the index room id from the
        // paired credentials and opens the WebSocket to the live server.
        syncManager.connect()

        // Await the real connection-state transition. If the server is
        // unreachable / rejects auth, this never flips and withTimeout throws,
        // failing the test loudly (NOT a vacuous pass).
        withTimeout(CONNECT_TIMEOUT_MS) {
            syncManager.state.first { it.indexConnected }
        }

        // Real public-API call: ask the server for the full index snapshot.
        syncManager.requestFullSync()

        // Await proof the snapshot round-trip completed (lastIndexSyncAt is set
        // by handleIndexSyncResponse only after a real server response).
        val syncedAt = withTimeout(SNAPSHOT_TIMEOUT_MS) {
            syncManager.state.first { it.lastIndexSyncAt != null }.lastIndexSyncAt
        }
        assertTrue("Expected an index sync timestamp from the server", syncedAt != null)

        // TODO(live-harness): with seeded server-side fixture data, assert on the
        // decrypted snapshot contents (repository.observeProjects() /
        // observeActiveSessions()) instead of just the sync timestamp.
    }

    // ---------------------------------------------------------------------
    // Session room: join
    // ---------------------------------------------------------------------

    @Test
    fun `session room joins for a session`() = runBlockingTest {
        syncManager.connect()
        withTimeout(CONNECT_TIMEOUT_MS) {
            syncManager.state.first { it.indexConnected }
        }

        // Real public-API call: open the per-session room WebSocket.
        syncManager.joinSessionRoom(TEST_SESSION_ID)

        // Await the real session-room connection. Unreachable -> timeout -> fail.
        withTimeout(CONNECT_TIMEOUT_MS) {
            syncManager.state.first { it.sessionConnected }
        }

        // TODO(live-harness): assert the session syncResponse hydrated messages
        // (await state.lastSessionSyncAt and inspect
        // repository.observeMessagesForSession(TEST_SESSION_ID)).
    }

    // ---------------------------------------------------------------------
    // Queued prompt submit round-trip
    // ---------------------------------------------------------------------

    @Test
    fun `queued prompt submit round-trips through the index room`() = runBlockingTest {
        syncManager.connect()
        withTimeout(CONNECT_TIMEOUT_MS) {
            syncManager.state.first { it.indexConnected }
        }

        // sendPrompt requires a local session row (it reads the session to build
        // the encrypted IndexUpdate) and crypto initialized by connect(). Seed a
        // minimal project + session for the project the live harness uses. The
        // project must exist first to satisfy the sessions->projects foreign key.
        repository.replaceIndexSnapshot(
            projects = listOf(seedProject(TEST_PROJECT_ID)),
            sessions = listOf(seedSession(TEST_SESSION_ID, TEST_PROJECT_ID)),
            syncedAt = 1_700_000_000_000L
        )

        // Real public-API call: encrypt + send the queued prompt to the server.
        val result = syncManager.sendPrompt(
            sessionId = TEST_SESSION_ID,
            text = "gated harness queued prompt"
        )

        // sendPrompt returns failure if the index room is not connected or the
        // send fails — so a green connection that silently dropped the prompt
        // still fails here.
        assertTrue(
            "Expected sendPrompt to succeed against the live server: " +
                result.exceptionOrNull()?.message,
            result.isSuccess
        )

        // The prompt is persisted locally as a sent queued prompt; confirm it.
        val queued = withTimeout(SNAPSHOT_TIMEOUT_MS) {
            repository.observeQueuedPromptsForSession(TEST_SESSION_ID)
                .first { prompts -> prompts.any { it.sentAt != null } }
        }
        assertTrue("Expected a locally-recorded sent queued prompt", queued.isNotEmpty())

        // TODO(live-harness): with a second connected client (or wrangler tail),
        // assert the desktop side received the queued-prompt IndexUpdate and that
        // it clears once processing begins.
    }

    // ---------------------------------------------------------------------
    // Session control round-trip
    // ---------------------------------------------------------------------

    @Test
    fun `session control message sends through the index room`() = runBlockingTest {
        syncManager.connect()
        withTimeout(CONNECT_TIMEOUT_MS) {
            syncManager.state.first { it.indexConnected }
        }

        // Real public-API call: send a session-control message over the index
        // room (the channel desktop uses for interrupt / prompt_response etc.).
        val result = syncManager.sendSessionControlMessage(
            sessionId = TEST_SESSION_ID,
            messageType = "interrupt"
        )

        assertTrue(
            "Expected sendSessionControlMessage to succeed against the live server: " +
                result.exceptionOrNull()?.message,
            result.isSuccess
        )

        // TODO(live-harness): assert the desktop/server observed the control
        // message (server ack or echo on a second client).
    }

    // ---------------------------------------------------------------------
    // Gating + fixtures
    // ---------------------------------------------------------------------

    private fun seedProject(projectId: String) = ProjectEntity(
        id = projectId,
        name = File(projectId).name.ifBlank { projectId },
        sessionCount = 0,
        lastUpdatedAt = 1_700_000_000_000L,
        sortOrder = 0
    )

    private fun seedSession(sessionId: String, projectId: String) = SessionEntity(
        id = sessionId,
        projectId = projectId,
        titleDecrypted = "Gated harness session",
        provider = "claude-code",
        model = "claude-sonnet-4",
        mode = "agent",
        createdAt = 1_700_000_000_000L,
        updatedAt = 1_700_000_000_000L,
        lastSyncedSeq = 0,
        lastMessageAt = 1_700_000_000_000L
    )

    private fun liveCredentialsFromEnv(): PairingCredentials {
        val serverUrl = env("COLLAB_WS_URL") ?: DEFAULT_COLLAB_WS_URL
        return PairingCredentials(
            serverUrl = serverUrl,
            encryptionSeed = env("COLLAB_ENCRYPTION_SEED").orEmpty(),
            pairedUserId = env("COLLAB_AUTH_USER_ID"),
            authJwt = env("COLLAB_AUTH_JWT"),
            authUserId = env("COLLAB_AUTH_USER_ID"),
            orgId = env("COLLAB_ORG_ID"),
            sessionToken = env("COLLAB_SESSION_TOKEN")
        )
    }

    private companion object {
        // Default sync server WebSocket URL. ADJUST to match the nimbalyst-collab
        // dev server's actual port — this is a documented placeholder, not a
        // verified port for that repo.
        const val DEFAULT_COLLAB_WS_URL = "ws://127.0.0.1:8787"

        // Default sibling-repo path, relative to the monorepo root, mirroring the
        // electron specs' `../nimbalyst-collab` convention.
        const val DEFAULT_COLLAB_SERVER_PATH = "../nimbalyst-collab"

        const val TEST_SESSION_ID = "gated-harness-session"
        const val TEST_PROJECT_ID = "/gated/harness/project"

        // Real-thread network waits. Generous enough for a local dev server but
        // short enough to fail fast when the server is down.
        const val CONNECT_TIMEOUT_MS = 15_000L
        const val SNAPSHOT_TIMEOUT_MS = 15_000L

        fun env(name: String): String? = System.getenv(name)?.takeIf { it.isNotBlank() }

        /**
         * True only when collab tests are explicitly opted into AND the sibling
         * collab-server checkout exists. Mirrors the electron `RUN_COLLAB_TESTS=1`
         * + `COLLAB_SERVER_PATH` (default `../nimbalyst-collab`) gate.
         */
        fun collabTestsEnabled(): Boolean {
            if (System.getenv("RUN_COLLAB_TESTS") != "1") return false
            val serverPath = env("COLLAB_SERVER_PATH") ?: DEFAULT_COLLAB_SERVER_PATH
            return resolveCollabServerDir(serverPath) != null
        }

        /**
         * Resolve the collab-server directory, or null if not found.
         *
         * An absolute COLLAB_SERVER_PATH is used as-is. A relative one is resolved
         * by walking up from the gradle working directory (which varies by gradle
         * version / invocation — typically `packages/android` or
         * `packages/android/app`) and checking each ancestor for
         * `<ancestor>/<serverPath>`. This avoids hard-coding a `../..` depth, so a
         * correctly-placed sibling `../nimbalyst-collab` is found regardless of the
         * exact working directory.
         */
        fun resolveCollabServerDir(serverPath: String): File? {
            File(serverPath).takeIf { it.isAbsolute }?.let {
                return it.takeIf(File::isDirectory)
            }
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile.normalize()
            while (dir != null) {
                val candidate = dir.resolve(serverPath).normalize()
                if (candidate.isDirectory) return candidate
                dir = dir.parentFile
            }
            return null
        }
    }
}
