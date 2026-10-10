package com.nimbalyst.app.data

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Every schema change ships a migration and a committed schema JSON. There is
 * no destructive fallback: a missing migration must fail loudly in
 * [NimbalystMigrationTest], not wipe a user's cache on upgrade.
 */
internal object NimbalystMigrations {
    /** Session hierarchy and host fields, and the decoded project config. */
    val MIGRATION_1_2 = object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `sessions` ADD COLUMN `agentRole` TEXT")
            db.execSQL("ALTER TABLE `sessions` ADD COLUMN `createdBySessionId` TEXT")
            db.execSQL("ALTER TABLE `sessions` ADD COLUMN `hostDeviceId` TEXT")
            db.execSQL("ALTER TABLE `sessions` ADD COLUMN `pendingExecution` TEXT")
            db.execSQL(
                "CREATE INDEX IF NOT EXISTS `index_sessions_createdBySessionId` ON `sessions` (`createdBySessionId`)"
            )
            db.execSQL("ALTER TABLE `projects` ADD COLUMN `actionsJson` TEXT")
            db.execSQL("ALTER TABLE `projects` ADD COLUMN `gitRemoteHash` TEXT")
        }
    }

    /** Provisional placeholder projects (F2). */
    val MIGRATION_2_3 = object : Migration(2, 3) {
        override fun migrate(db: SupportSQLiteDatabase) {
            // Existing rows stay listed: nothing stored says which were stand-ins,
            // and a guess here would let the provisional prune delete real ones.
            db.execSQL("ALTER TABLE `projects` ADD COLUMN `isProvisional` INTEGER NOT NULL DEFAULT 0")
        }
    }

    /** Versioned (v2) index replication bookkeeping. New tables only; no existing row changes. */
    val MIGRATION_3_4 = object : Migration(3, 4) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS `index_row_revision` (`entity` TEXT NOT NULL, `id` TEXT NOT NULL, " +
                    "`revision` INTEGER NOT NULL, `deleted` INTEGER NOT NULL DEFAULT 0, " +
                    "`unreadable` INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(`entity`, `id`))"
            )
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS `index_replication_cursor` (`scope` TEXT NOT NULL, " +
                    "`cursor` INTEGER NOT NULL, `historyComplete` INTEGER NOT NULL, PRIMARY KEY(`scope`))"
            )
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS `index_bootstrap_seen` (`runId` TEXT NOT NULL, `entity` TEXT NOT NULL, " +
                    "`id` TEXT NOT NULL, PRIMARY KEY(`runId`, `entity`, `id`))"
            )
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS `index_bootstrap_finalization` (`runId` TEXT NOT NULL, " +
                    "`cursor` INTEGER NOT NULL, `startedAt` INTEGER NOT NULL, PRIMARY KEY(`runId`))"
            )
        }
    }

    /** The server's last client-metadata blob per session, so a draft push after a restart keeps the desktop's fields. */
    val MIGRATION_4_5 = object : Migration(4, 5) {
        override fun migrate(db: SupportSQLiteDatabase) {
            // Starts empty: a draft waits for the next index sync to supply the blob.
            db.execSQL("ALTER TABLE `sessions` ADD COLUMN `clientMetadataJson` TEXT")
        }
    }

    /** The project's Local wiki folder and types from its config. Null until the next config arrives. */
    val MIGRATION_5_6 = object : Migration(5, 6) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `projects` ADD COLUMN `localWikiFolder` TEXT")
            db.execSQL("ALTER TABLE `projects` ADD COLUMN `localWikiTypesJson` TEXT")
        }
    }

    val ALL: Array<Migration> = arrayOf(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6)
}
