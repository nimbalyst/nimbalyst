/**
 * Dump all data from recovered database to JSON files
 */

const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

async function dumpToJSON() {
  const dbPath = '/Users/ghinkle/Library/Application Support/@nimbalyst/electron/pglite-db-old';
  const outputDir = './recovered-data';

  console.log('Dumping database to JSON files...');
  console.log('Database path:', dbPath);
  console.log('Output directory:', outputDir);
  console.log('='.repeat(80));

  try {
    // Create output directory
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log('\n1. Opening database...');
    const db = new PGlite({
      dataDir: dbPath,
      debug: 0
    });

    await db.waitReady;
    console.log('  Database opened successfully!');

    // Get list of tables
    console.log('\n2. Getting table list...');
    const tablesResult = await db.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    const tables = tablesResult.rows.map(r => r.tablename);
    console.log('  Tables found:', tables.length);

    // Dump each table
    console.log('\n3. Dumping tables...');
    for (const table of tables) {
      try {
        console.log(`  - Dumping ${table}...`);
        const result = await db.query(`SELECT * FROM ${table}`);
        const outputPath = path.join(outputDir, `${table}.json`);

        fs.writeFileSync(outputPath, JSON.stringify(result.rows, null, 2), 'utf8');
        console.log(`    Saved ${result.rows.length} rows to ${table}.json`);
      } catch (error) {
        console.error(`    ERROR dumping ${table}:`, error.message);
      }
    }

    // Create a summary file
    console.log('\n4. Creating summary...');
    const summary = {
      timestamp: new Date().toISOString(),
      database_path: dbPath,
      tables: {}
    };

    for (const table of tables) {
      try {
        const countResult = await db.query(`SELECT COUNT(*) as count FROM ${table}`);
        summary.tables[table] = countResult.rows[0].count;
      } catch (error) {
        summary.tables[table] = `ERROR: ${error.message}`;
      }
    }

    fs.writeFileSync(
      path.join(outputDir, '_summary.json'),
      JSON.stringify(summary, null, 2),
      'utf8'
    );

    await db.close();
    console.log('\n✓ Dump completed successfully!');
    console.log('\nRecovered data saved to:', outputDir);
    console.log('\nNext steps:');
    console.log('  1. Review the JSON files in:', outputDir);
    console.log('  2. Import important data (ai_sessions, document_history) into current database');
    console.log('  3. Keep the recovered database as backup');

  } catch (error) {
    console.error('\n✗ Dump failed:');
    console.error('  Error:', error.message);
    console.error('  Stack:', error.stack);
    process.exit(1);
  }
}

dumpToJSON().catch(console.error);
