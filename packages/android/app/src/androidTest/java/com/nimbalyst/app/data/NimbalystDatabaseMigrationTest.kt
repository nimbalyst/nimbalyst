package com.nimbalyst.app.data

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NimbalystDatabaseMigrationTest {
    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        NimbalystDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory()
    )

    @Test
    fun migrate1To2PreservesSessionsAndAddsAgentStatusColumns() {
        val databaseName = "nimbalyst-migration-test.db"

        helper.createDatabase(databaseName, 1).apply {
            execSQL(
                """
                INSERT INTO projects (id, name, sessionCount, lastUpdatedAt, sortOrder)
                VALUES ('project-1', 'Project One', 1, 1000, 0)
                """.trimIndent()
            )
            execSQL(
                """
                INSERT INTO sessions (
                    id,
                    projectId,
                    titleDecrypted,
                    provider,
                    model,
                    mode,
                    isArchived,
                    isPinned,
                    isExecuting,
                    hasQueuedPrompts,
                    createdAt,
                    updatedAt,
                    lastSyncedSeq,
                    lastMessageAt,
                    draftInput,
                    draftUpdatedAt
                ) VALUES (
                    'session-1',
                    'project-1',
                    'Existing session',
                    'claude-code',
                    'claude-sonnet-4',
                    'agent',
                    0,
                    1,
                    0,
                    0,
                    1100,
                    1200,
                    42,
                    1300,
                    'unsynced draft',
                    1400
                )
                """.trimIndent()
            )
            close()
        }

        val db = helper.runMigrationsAndValidate(
            databaseName,
            2,
            true,
            NimbalystDatabase.MIGRATION_1_2
        )

        db.query(
            """
            SELECT
                titleDecrypted,
                isPinned,
                lastSyncedSeq,
                draftInput,
                agentStatusKind,
                agentStatusLabel,
                agentStatusDetail,
                agentStatusUpdatedAt
            FROM sessions
            WHERE id = 'session-1'
            """.trimIndent()
        ).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("Existing session", cursor.getString(0))
            assertEquals(1, cursor.getInt(1))
            assertEquals(42L, cursor.getLong(2))
            assertEquals("unsynced draft", cursor.getString(3))
            assertTrue(cursor.isNull(4))
            assertTrue(cursor.isNull(5))
            assertTrue(cursor.isNull(6))
            assertTrue(cursor.isNull(7))
        }

        db.close()
    }

    @Test
    fun migrate3To4DeletesLegacySourceNullQueuedPrompts() {
        val databaseName = "nimbalyst-migration-test-3-4.db"

        helper.createDatabase(databaseName, 3).apply {
            execSQL(
                """
                INSERT INTO projects (id, name, sessionCount, lastUpdatedAt, sortOrder)
                VALUES ('project-1', 'Project One', 1, 1000, 0)
                """.trimIndent()
            )
            execSQL(
                """
                INSERT INTO sessions (
                    id,
                    projectId,
                    titleEncrypted,
                    titleIv,
                    titleDecrypted,
                    isArchived,
                    isPinned,
                    isExecuting,
                    hasQueuedPrompts,
                    createdAt,
                    updatedAt,
                    lastSyncedSeq
                ) VALUES (
                    'session-1',
                    'project-1',
                    '',
                    '',
                    'Existing session',
                    0,
                    0,
                    0,
                    1,
                    1100,
                    1200,
                    0
                )
                """.trimIndent()
            )
            execSQL(
                """
                INSERT INTO queued_prompts (
                    id,
                    sessionId,
                    promptTextEncrypted,
                    iv,
                    createdAt,
                    sentAt,
                    promptTextDecrypted,
                    source
                ) VALUES (
                    'legacy-prompt',
                    'session-1',
                    'ciphertext',
                    'iv',
                    1300,
                    NULL,
                    'stale prompt',
                    NULL
                )
                """.trimIndent()
            )
            close()
        }

        val db = helper.runMigrationsAndValidate(
            databaseName,
            4,
            true,
            NimbalystDatabase.MIGRATION_3_4
        )

        db.query("SELECT COUNT(*) FROM queued_prompts").use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(0, cursor.getInt(0))
        }

        db.close()
    }
}
