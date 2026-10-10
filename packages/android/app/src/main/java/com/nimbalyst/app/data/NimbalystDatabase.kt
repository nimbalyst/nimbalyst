package com.nimbalyst.app.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters

@Database(
    entities = [
        ProjectEntity::class,
        SessionEntity::class,
        MessageEntity::class,
        QueuedPromptEntity::class,
        SyncStateEntity::class,
        IndexRowRevisionEntity::class,
        IndexReplicationCursorEntity::class,
        IndexBootstrapSeenEntity::class,
        IndexBootstrapFinalizationEntity::class,
    ],
    version = NimbalystDatabase.VERSION,
    // Schemas are committed under app/schemas and are what the migration
    // tests open. Committed files are also what keeps the Debug and Release
    // KSP runs from racing to create the same file ("Empty schema file").
    exportSchema = true
)
@TypeConverters(PendingExecutionConverter::class)
abstract class NimbalystDatabase : RoomDatabase() {
    abstract fun projectDao(): ProjectDao
    abstract fun sessionDao(): SessionDao
    abstract fun messageDao(): MessageDao
    abstract fun queuedPromptDao(): QueuedPromptDao
    abstract fun syncStateDao(): SyncStateDao
    abstract fun indexReplicationDao(): IndexReplicationDao

    companion object {
        const val VERSION = 6
        const val DATABASE_NAME = "nimbalyst-android.db"

        @Volatile
        private var instance: NimbalystDatabase? = null

        @androidx.annotation.VisibleForTesting
        internal fun resetInstanceForTest() {
            instance = null
        }

        fun getInstance(context: Context): NimbalystDatabase {
            return instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    NimbalystDatabase::class.java,
                    DATABASE_NAME
                )
                    .addMigrations(*NimbalystMigrations.ALL)
                    // No seed data: a new install starts empty. Demo content for
                    // screenshots lives in the debug-only screenshots package.
                    .build()
                    .also { instance = it }
            }
        }
    }
}
