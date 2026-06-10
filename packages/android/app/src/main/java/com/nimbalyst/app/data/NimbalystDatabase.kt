package com.nimbalyst.app.data

import android.content.ContentValues
import android.content.Context
import androidx.room.Database
import androidx.room.migration.Migration
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase
import org.json.JSONObject

@Database(
    entities = [
        ProjectEntity::class,
        SessionEntity::class,
        MessageEntity::class,
        QueuedPromptEntity::class,
        SyncStateEntity::class,
    ],
    version = 2,
    exportSchema = true
)
abstract class NimbalystDatabase : RoomDatabase() {
    abstract fun projectDao(): ProjectDao
    abstract fun sessionDao(): SessionDao
    abstract fun messageDao(): MessageDao
    abstract fun queuedPromptDao(): QueuedPromptDao
    abstract fun syncStateDao(): SyncStateDao

    companion object {
        @Volatile
        private var instance: NimbalystDatabase? = null

        fun getInstance(context: Context): NimbalystDatabase {
            return instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    NimbalystDatabase::class.java,
                    "nimbalyst-android.db"
                )
                    .addMigrations(MIGRATION_1_2)
                    .addCallback(object : Callback() {
                        override fun onCreate(db: SupportSQLiteDatabase) {
                            super.onCreate(db)
                            seedDatabase(db)
                        }
                    })
                    .build()
                    .also { instance = it }
            }
        }

        private fun seedDatabase(db: SupportSQLiteDatabase) {
            val now = System.currentTimeMillis()

            db.insert(
                "projects",
                0,
                ContentValues().apply {
                    put("id", "/test/android")
                    put("name", "Android Prototype Project")
                    put("sessionCount", 2)
                    put("lastUpdatedAt", now)
                    put("sortOrder", 0)
                }
            )

            val sessions = listOf(
                SessionEntity(
                    id = "session-android-scaffold",
                    projectId = "/test/android",
                    titleDecrypted = "Android native scaffold",
                    provider = "claude-code",
                    model = "claude-sonnet-4",
                    mode = "agent",
                    createdAt = now - 3_600_000,
                    updatedAt = now - 60_000,
                    lastMessageAt = now - 60_000
                ),
                SessionEntity(
                    id = "session-sync-roadmap",
                    projectId = "/test/android",
                    titleDecrypted = "Sync manager roadmap",
                    provider = "claude-code",
                    model = "claude-sonnet-4",
                    mode = "planning",
                    createdAt = now - 7_200_000,
                    updatedAt = now - 120_000,
                    lastMessageAt = now - 120_000
                )
            )

            sessions.forEach { session ->
                db.insert(
                    "sessions",
                    0,
                    ContentValues().apply {
                        put("id", session.id)
                        put("projectId", session.projectId)
                        put("titleDecrypted", session.titleDecrypted)
                        put("provider", session.provider)
                        put("model", session.model)
                        put("mode", session.mode)
                        put("isArchived", 0)
                        put("isPinned", 0)
                        put("isExecuting", if (session.isExecuting) 1 else 0)
                        put("agentStatusKind", session.agentStatusKind)
                        put("agentStatusLabel", session.agentStatusLabel)
                        put("agentStatusDetail", session.agentStatusDetail)
                        put("agentStatusUpdatedAt", session.agentStatusUpdatedAt)
                        put("hasQueuedPrompts", 0)
                        put("createdAt", session.createdAt)
                        put("updatedAt", session.updatedAt)
                        put("lastSyncedSeq", 0)
                        put("lastMessageAt", session.lastMessageAt)
                    }
                )
            }

            seededMessages(now).forEach { message ->
                db.insert(
                    "messages",
                    0,
                    ContentValues().apply {
                        put("id", message.id)
                        put("sessionId", message.sessionId)
                        put("sequence", message.sequence)
                        put("source", message.source)
                        put("direction", message.direction)
                        put("encryptedContent", message.encryptedContent)
                        put("iv", message.iv)
                        put("contentDecrypted", message.contentDecrypted)
                        put("metadataJson", message.metadataJson)
                        put("createdAt", message.createdAt)
                    }
                )
            }
        }

        internal val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE sessions ADD COLUMN agentStatusKind TEXT")
                db.execSQL("ALTER TABLE sessions ADD COLUMN agentStatusLabel TEXT")
                db.execSQL("ALTER TABLE sessions ADD COLUMN agentStatusDetail TEXT")
                db.execSQL("ALTER TABLE sessions ADD COLUMN agentStatusUpdatedAt INTEGER")
            }
        }

        private fun seededMessages(now: Long): List<MessageEntity> {
            fun envelope(innerContent: String): String {
                return JSONObject()
                    .put("content", innerContent)
                    .put("metadata", JSONObject.NULL)
                    .put("hidden", false)
                    .toString()
            }

            return listOf(
                MessageEntity(
                    id = "msg-1",
                    sessionId = "session-android-scaffold",
                    sequence = 1,
                    source = "user",
                    direction = "input",
                    contentDecrypted = envelope("""{"prompt":"Create a simple hello world function and explain how it works"}"""),
                    createdAt = now - 350_000
                ),
                MessageEntity(
                    id = "msg-2",
                    sessionId = "session-android-scaffold",
                    sequence = 2,
                    source = "claude-code",
                    direction = "output",
                    contentDecrypted = envelope("""{"type":"text","content":"I'll create a simple hello world function for you and explain how it works."}"""),
                    createdAt = now - 348_000
                ),
                MessageEntity(
                    id = "msg-3",
                    sessionId = "session-android-scaffold",
                    sequence = 3,
                    source = "claude-code",
                    direction = "output",
                    contentDecrypted = envelope("""{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tool-write-1","name":"Write","input":{"file_path":"/test/hello.js","content":"/**\n * A simple hello world function\n */\nfunction hello(name = 'World') {\n  console.log('Hello, ' + name + '!');\n  return 'Greeted ' + name;\n}\n\nhello();\nhello('Nimbalyst');"}}]}}"""),
                    createdAt = now - 346_000
                ),
                MessageEntity(
                    id = "msg-4",
                    sessionId = "session-android-scaffold",
                    sequence = 4,
                    source = "user",
                    direction = "input",
                    contentDecrypted = envelope("""{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-write-1","content":[{"type":"text","text":"File written successfully"}]}]}}"""),
                    createdAt = now - 344_000
                ),
                MessageEntity(
                    id = "msg-5",
                    sessionId = "session-android-scaffold",
                    sequence = 5,
                    source = "claude-code",
                    direction = "output",
                    contentDecrypted = envelope("""{"type":"text","content":"I've created a hello world function with default parameters, template literals, and a return value. The Android transcript host is rendering the same message envelope structure iOS uses."}"""),
                    createdAt = now - 342_000
                ),
                MessageEntity(
                    id = "msg-6",
                    sessionId = "session-sync-roadmap",
                    sequence = 1,
                    source = "user",
                    direction = "input",
                    contentDecrypted = envelope("""{"prompt":"Outline the next implementation steps for Android sync parity."}"""),
                    createdAt = now - 180_000
                ),
                MessageEntity(
                    id = "msg-7",
                    sessionId = "session-sync-roadmap",
                    sequence = 2,
                    source = "claude-code",
                    direction = "output",
                    contentDecrypted = envelope("""{"type":"text","content":"Next up are secure storage, QR pairing, auth callbacks, and the WebSocket sync manager. The Room-backed Android shell is now ready for those layers."}"""),
                    createdAt = now - 175_000
                )
            )
        }
    }
}
