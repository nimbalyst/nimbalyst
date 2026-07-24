#!/usr/bin/env node

/**
 * Test PGLite database functionality
 */

const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const os = require('os');

async function testPGLite() {
  console.log('=== PGLite Test ===\n');

  const dataDir = path.join(os.tmpdir(), 'pglite-test-' + Date.now());
  console.log('Database directory:', dataDir);

  try {
    // 1. Create database
    console.log('\n1. Creating database...');
    const db = new PGlite({
      dataDir: dataDir,
      debug: 1
    });

    await db.waitReady;
    console.log('✓ Database created\n');

    // 2. Create table
    console.log('2. Creating table...');
    await db.exec(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✓ Table created\n');

    // 3. Insert data
    console.log('3. Inserting data...');
    const insertResult = await db.query(
      'INSERT INTO users (name, email) VALUES ($1, $2), ($3, $4) RETURNING *',
      ['Alice', 'alice@example.com', 'Bob', 'bob@example.com']
    );
    console.log(`✓ Inserted ${insertResult.rows.length} rows`);
    console.log('Data:', insertResult.rows);
    console.log('');

    // 4. Query data
    console.log('4. Querying data...');
    const selectResult = await db.query('SELECT * FROM users ORDER BY name');
    console.log(`Found ${selectResult.rows.length} users:`);
    selectResult.rows.forEach(row => {
      console.log(`  - ${row.name} (${row.email})`);
    });
    console.log('');

    // 5. Test JSON support
    console.log('5. Testing JSON support...');
    await db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      )
    `);

    await db.query(
      'INSERT INTO sessions (id, data) VALUES ($1, $2)',
      ['session-1', JSON.stringify({ user: 'alice', messages: ['Hello', 'World'] })]
    );

    const jsonResult = await db.query('SELECT id, data FROM sessions');
    console.log('✓ JSON data stored and retrieved:');
    console.log('  ', jsonResult.rows[0]);
    console.log('');

    // 6. Test transaction
    console.log('6. Testing transaction...');
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO users (name, email) VALUES ($1, $2)', ['Charlie', 'charlie@example.com']);
      await tx.query('INSERT INTO users (name, email) VALUES ($1, $2)', ['David', 'david@example.com']);
    });

    const afterTx = await db.query('SELECT COUNT(*) as count FROM users');
    console.log(`✓ Transaction completed. Total users: ${afterTx.rows[0].count}\n`);

    // 7. Get database size
    console.log('7. Database stats...');
    const stats = await db.query(`
      SELECT
        pg_database_size(current_database()) as size,
        (SELECT COUNT(*) FROM users) as user_count,
        (SELECT COUNT(*) FROM sessions) as session_count
    `);
    console.log('Database size:', stats.rows[0].size, 'bytes');
    console.log('User count:', stats.rows[0].user_count);
    console.log('Session count:', stats.rows[0].session_count);
    console.log('');

    // 8. Close database
    console.log('8. Closing database...');
    await db.close();
    console.log('✓ Database closed\n');

    console.log('=== ✓ All tests passed ===');
  } catch (error) {
    console.error('\n=== ✗ Test failed ===');
    console.error(error);
    process.exit(1);
  }
}

// Run test
testPGLite()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });