package com.nimbalyst.app.data

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Upgrades a real on-disk database, built from the committed schema JSON for
 * each old version, through [NimbalystDatabase.getInstance]. Room validates the
 * migrated tables against the current entities, so a migration that forgets a
 * column or index fails here. The data assertions catch the other failure: a
 * destructive fallback that "migrates" by dropping everything.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class NimbalystMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Before
    fun setUp() {
        NimbalystDatabase.resetInstanceForTest()
        context.deleteDatabase(NimbalystDatabase.DATABASE_NAME)
    }

    @After
    fun tearDown() {
        NimbalystDatabase.resetInstanceForTest()
        context.deleteDatabase(NimbalystDatabase.DATABASE_NAME)
    }

    @Test
    fun `v1 data survives the upgrade and the new columns start empty`() = runBlocking {
        createFromSchema(version = 1) { db ->
            db.execSQL(
                "INSERT INTO projects (id, name, sessionCount, lastUpdatedAt, sortOrder, commandsJson) " +
                    "VALUES ('/p', 'p', 1, 10, 0, NULL)"
            )
            db.execSQL(
                "INSERT INTO sessions (id, projectId, titleDecrypted, isArchived, isPinned, isExecuting, " +
                    "hasQueuedPrompts, createdAt, updatedAt, lastSyncedSeq, draftInput) " +
                    "VALUES ('s1', '/p', 'Title', 0, 0, 0, 0, 1, 2, 7, 'draft')"
            )
            db.execSQL(
                "INSERT INTO messages (id, sessionId, sequence, source, direction, encryptedContent, iv, createdAt) " +
                    "VALUES ('m1', 's1', 1, 'user', 'input', 'c', 'iv', 3)"
            )
            db.execSQL("INSERT INTO sync_state (roomId, lastSequence) VALUES ('s1', 7)")
        }

        val database = NimbalystDatabase.getInstance(context)
        val session = database.sessionDao().getById("s1")!!
        assertEquals("Title", session.titleDecrypted)
        assertEquals("draft", session.draftInput)
        assertEquals(7, session.lastSyncedSeq)
        assertNull(session.agentRole)
        assertNull(session.createdBySessionId)
        assertNull(session.hostDeviceId)
        assertNull(session.pendingExecution)
        assertEquals(1, database.messageDao().countForSession("s1"))
        assertEquals(7, database.syncStateDao().getByRoomId("s1")!!.lastSequence)

        // Room 2.7+ asserts RoomDatabase.query off the main thread; the raw helper does not.
        val projects = database.openHelper.readableDatabase.query("SELECT gitRemoteHash, actionsJson, isProvisional FROM projects WHERE id = '/p'")
        projects.use {
            assertTrue(it.moveToFirst())
            assertTrue(it.isNull(0))
            assertTrue(it.isNull(1))
            assertEquals("an upgraded project stays listed", 0, it.getInt(2))
        }
    }

    @Test
    fun `v4 sessions keep their draft and start with no known metadata blob`() = runBlocking {
        createFromSchema(version = 4) { db ->
            db.execSQL("INSERT INTO projects (id, name, sessionCount, sortOrder, isProvisional) VALUES ('/p', 'p', 1, 0, 0)")
            db.execSQL(
                "INSERT INTO sessions (id, projectId, isArchived, isPinned, isExecuting, hasQueuedPrompts, " +
                    "createdAt, updatedAt, lastSyncedSeq, draftInput) VALUES ('s1', '/p', 0, 0, 0, 0, 1, 2, 0, 'draft')"
            )
        }

        val session = NimbalystDatabase.getInstance(context).sessionDao().getById("s1")!!
        assertEquals("draft", session.draftInput)
        // Unknown until the next index sync: a draft waits rather than guessing the blob.
        assertNull(session.clientMetadataJson)
    }

    @Test
    fun `v5 projects keep their config and start with no Local wiki folder`() = runBlocking {
        createFromSchema(version = 5) { db ->
            db.execSQL("INSERT INTO projects (id, name, sessionCount, sortOrder, commandsJson, isProvisional) VALUES ('/p', 'p', 1, 0, '[]', 0)")
        }

        val database = NimbalystDatabase.getInstance(context)
        val projects = database.openHelper.readableDatabase.query("SELECT commandsJson, localWikiFolder, localWikiTypesJson FROM projects WHERE id = '/p'")
        projects.use {
            assertTrue(it.moveToFirst())
            assertEquals("[]", it.getString(0))
            assertTrue(it.isNull(1))
            assertTrue(it.isNull(2))
        }
    }

    @Test
    fun `every schema version up to the current one is committed`() {
        val current = NimbalystDatabase.VERSION
        for (version in 1..current) {
            assertTrue("schema $version.json is missing", schemaFile(version).isFile)
        }
    }

    /** Opens a bare SQLite file at [version] exactly as that version's Room would have created it. */
    private fun createFromSchema(version: Int, seed: (SupportSQLiteDatabase) -> Unit) {
        val schema = JSONObject(schemaFile(version).readText()).getJSONObject("database")
        val config = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(NimbalystDatabase.DATABASE_NAME)
            .callback(object : SupportSQLiteOpenHelper.Callback(version) {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    val entities = schema.getJSONArray("entities")
                    for (i in 0 until entities.length()) {
                        val entity = entities.getJSONObject(i)
                        val table = entity.getString("tableName")
                        db.execSQL(entity.getString("createSql").replace("\${TABLE_NAME}", table))
                        val indices = entity.optJSONArray("indices") ?: continue
                        for (j in 0 until indices.length()) {
                            db.execSQL(indices.getJSONObject(j).getString("createSql").replace("\${TABLE_NAME}", table))
                        }
                    }
                    val setup = schema.getJSONArray("setupQueries")
                    for (i in 0 until setup.length()) db.execSQL(setup.getString(i))
                }

                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            })
            .build()
        FrameworkSQLiteOpenHelperFactory().create(config).use { helper ->
            seed(helper.writableDatabase)
        }
    }

    // Gradle runs unit tests from the module directory.
    private fun schemaFile(version: Int) =
        File("schemas/${NimbalystDatabase::class.java.name}/$version.json")
}
