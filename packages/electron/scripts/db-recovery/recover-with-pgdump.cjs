/**
 * Attempt to recover data from corrupted PGLite database using pg_dump
 */

const { PGlite } = require('@electric-sql/pglite');
const { pgDump } = require('@electric-sql/pglite-tools');
const fs = require('fs');
const path = require('path');

async function attemptRecovery() {
  const dbPath = '/Users/ghinkle/Library/Application Support/@nimbalyst/electron/pglite-db-old';
  const outputPath = './corrupted-db-dump.sql';

  console.log('Attempting to recover data using pg_dump...');
  console.log('Database path:', dbPath);
  console.log('Output path:', outputPath);
  console.log('='.repeat(80));

  try {
    console.log('\n1. Opening database...');
    const db = new PGlite({
      dataDir: dbPath,
      debug: 1
    });

    await db.waitReady;
    console.log('  Database opened successfully!');

    console.log('\n2. Running pg_dump...');
    const dumpResult = await pgDump(db, {
      // Options from pglite-tools documentation
      dataOnly: false,        // Include schema
      schemaOnly: false,      // Include data
      format: 'plain',        // Plain SQL format
    });

    console.log('  Dump completed! Size:', dumpResult.length, 'bytes');

    console.log('\n3. Writing dump to file...');
    fs.writeFileSync(outputPath, dumpResult, 'utf8');
    console.log('  Dump saved to:', outputPath);

    await db.close();
    console.log('\n✓ Recovery completed successfully!');
    console.log('\nNext steps:');
    console.log('  1. Review the dump file:', outputPath);
    console.log('  2. Use pg_restore or import the SQL file into a new database');

  } catch (error) {
    console.error('\n✗ Recovery failed:');
    console.error('  Error:', error.message);
    console.error('  Stack:', error.stack);

    if (error.message?.includes('Aborted')) {
      console.log('\n  The database is too corrupted for pg_dump to work.');
      console.log('  The checkpoint corruption prevents even read access.');
      console.log('\n  Alternative: Try using pg_resetwal from native PostgreSQL 17');
      console.log('  WARNING: This will reset the WAL and may cause data loss');
      console.log('\n  Command:');
      console.log('    brew install postgresql@17');
      console.log('    /opt/homebrew/opt/postgresql@17/bin/pg_resetwal -f "' + dbPath + '"');
    }

    process.exit(1);
  }
}

attemptRecovery().catch(console.error);
