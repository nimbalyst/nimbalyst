/**
 * Script to inspect corrupted PGLite database
 */

const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

async function inspectDatabase() {
  const dbPath = '/Users/ghinkle/Library/Application Support/@nimbalyst/electron/pglite-db-old';

  console.log('Attempting to open corrupted database at:', dbPath);
  console.log('='.repeat(80));

  try {
    // Try to open database in read-only mode if possible
    console.log('\n1. Opening database...');
    const db = new PGlite({
      dataDir: dbPath,
      debug: 1
    });

    await db.waitReady;
    console.log('  Database opened successfully!');

    // Try basic connectivity
    console.log('\n2. Testing basic query...');
    const result = await db.query('SELECT 1 as test');
    console.log('  Basic query result:', result.rows);

    // Try to check database version
    console.log('\n3. Checking PostgreSQL version...');
    const versionResult = await db.query('SELECT version()');
    console.log('  Version:', versionResult.rows[0]?.version);

    // List tables
    console.log('\n4. Listing tables...');
    const tablesResult = await db.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    console.log('  Tables found:', tablesResult.rows.map(r => r.tablename));

    // Check each table's row count
    console.log('\n5. Checking table row counts...');
    for (const row of tablesResult.rows) {
      try {
        const countResult = await db.query(`SELECT COUNT(*) as count FROM ${row.tablename}`);
        console.log(`  ${row.tablename}: ${countResult.rows[0].count} rows`);
      } catch (error) {
        console.error(`  ${row.tablename}: ERROR - ${error.message}`);
      }
    }

    // Try to dump ai_sessions
    console.log('\n6. Sampling ai_sessions data...');
    try {
      const sessionsResult = await db.query(`
        SELECT id, provider, model, title, workspace_id, created_at
        FROM ai_sessions
        LIMIT 5
      `);
      console.log('  Sample sessions:', JSON.stringify(sessionsResult.rows, null, 2));
    } catch (error) {
      console.error('  ERROR:', error.message);
    }

    // Check database integrity
    console.log('\n7. Running integrity check...');
    try {
      const integrityResult = await db.query('PRAGMA integrity_check');
      console.log('  Integrity check:', integrityResult.rows);
    } catch (error) {
      console.error('  ERROR (PRAGMA not supported in PostgreSQL):', error.message);
    }

    await db.close();
    console.log('\n✓ Database inspection completed successfully');

  } catch (error) {
    console.error('\n✗ Failed to inspect database:');
    console.error('  Error:', error.message);
    console.error('  Stack:', error.stack);

    // Additional diagnostic info
    console.log('\nDiagnostic Information:');
    console.log('  Database path:', dbPath);
    console.log('  Error type:', error.constructor.name);

    if (error.message?.includes('Aborted')) {
      console.log('\n  This is the same WASM abort error that prevents startup.');
      console.log('  The database files are likely corrupted at the binary level.');
    }

    process.exit(1);
  }
}

inspectDatabase().catch(console.error);
