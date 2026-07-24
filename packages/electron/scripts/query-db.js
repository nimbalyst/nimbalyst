#!/usr/bin/env node
/**
 * PGLite Database Query Utility
 *
 * Allows direct querying of the PGLite database for debugging and testing.
 *
 * Usage:
 *   node scripts/query-db.js "SELECT * FROM session_files LIMIT 10"
 *   node scripts/query-db.js --table session_files
 *   node scripts/query-db.js --sessions
 *   node scripts/query-db.js --files-by-session <session-id>
 */

import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get database path (same as the app uses)
const userDataPath = join(homedir(), 'Library', 'Application Support', '@nimbalyst', 'electron');
const dbPath = join(userDataPath, 'pglite-db');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
PGLite Database Query Utility

Usage:
  node scripts/query-db.js "SELECT * FROM session_files LIMIT 10"
  node scripts/query-db.js --table <table-name>
  node scripts/query-db.js --sessions
  node scripts/query-db.js --files-by-session <session-id>
  node scripts/query-db.js --schema
  node scripts/query-db.js --stats

Available tables:
  - ai_sessions
  - session_files
  - app_settings
  - project_state
  - session_state
  - document_history
`);
    process.exit(0);
  }

  console.log(`📂 Opening database at: ${dbPath} (read-only mode)`);
  const db = new PGlite(dbPath, { readonly: true });

  try {
    // Handle different command types
    if (args[0] === '--table') {
      const tableName = args[1];
      if (!tableName) {
        console.error('❌ Please specify a table name');
        process.exit(1);
      }
      const result = await db.query(`SELECT * FROM ${tableName} ORDER BY id DESC LIMIT 20`);
      console.log(`\n📊 Table: ${tableName} (last 20 rows)`);
      console.table(result.rows);
      console.log(`\n✅ Total rows shown: ${result.rows.length}`);
    }
    else if (args[0] === '--sessions') {
      const result = await db.query(`
        SELECT id, provider, model, workspace_path, created_at, updated_at
        FROM ai_sessions
        ORDER BY updated_at DESC
        LIMIT 20
      `);
      console.log('\n📊 Recent AI Sessions:');
      console.table(result.rows);
      console.log(`\n✅ Total sessions shown: ${result.rows.length}`);
    }
    else if (args[0] === '--files-by-session') {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('❌ Please specify a session ID');
        process.exit(1);
      }

      const result = await db.query(`
        SELECT id, session_id, file_path, link_type, timestamp, metadata
        FROM session_files
        WHERE session_id = $1
        ORDER BY timestamp DESC
      `, [sessionId]);

      console.log(`\n📊 Files for session: ${sessionId}`);
      console.table(result.rows);
      console.log(`\n✅ Total files: ${result.rows.length}`);

      // Show counts by type
      const stats = await db.query(`
        SELECT link_type, COUNT(*) as count
        FROM session_files
        WHERE session_id = $1
        GROUP BY link_type
      `, [sessionId]);
      console.log('\n📈 Files by type:');
      console.table(stats.rows);
    }
    else if (args[0] === '--schema') {
      const result = await db.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      console.log('\n📋 Database Tables:');
      console.table(result.rows);

      // Show schema for each table
      for (const row of result.rows) {
        const tableName = row.table_name;
        const columns = await db.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = $1
          ORDER BY ordinal_position
        `, [tableName]);
        console.log(`\n📊 Schema for ${tableName}:`);
        console.table(columns.rows);
      }
    }
    else if (args[0] === '--stats') {
      console.log('\n📈 Database Statistics:\n');

      // Session files stats
      const fileStats = await db.query(`
        SELECT
          link_type,
          COUNT(*) as count,
          COUNT(DISTINCT session_id) as sessions,
          COUNT(DISTINCT file_path) as unique_files
        FROM session_files
        GROUP BY link_type
      `);
      console.log('Session Files:');
      console.table(fileStats.rows);

      // Sessions stats
      const sessionStats = await db.query(`
        SELECT
          provider,
          COUNT(*) as count,
          COUNT(DISTINCT workspace_path) as workspaces
        FROM ai_sessions
        GROUP BY provider
      `);
      console.log('\nAI Sessions by Provider:');
      console.table(sessionStats.rows);

      // Recent activity
      const recent = await db.query(`
        SELECT
          DATE(to_timestamp(updated_at / 1000)) as date,
          COUNT(*) as sessions_updated
        FROM ai_sessions
        WHERE updated_at > extract(epoch from now() - interval '7 days') * 1000
        GROUP BY DATE(to_timestamp(updated_at / 1000))
        ORDER BY date DESC
      `);
      console.log('\nRecent Session Activity (last 7 days):');
      console.table(recent.rows);
    }
    else {
      // Execute custom SQL query
      const query = args.join(' ');
      console.log(`\n🔍 Executing: ${query}\n`);
      const result = await db.query(query);

      if (result.rows.length > 0) {
        console.table(result.rows);
        console.log(`\n✅ Returned ${result.rows.length} rows`);
      } else {
        console.log('✅ Query executed successfully (no rows returned)');
      }
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
