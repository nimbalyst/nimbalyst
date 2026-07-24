/**
 * Restore the recovered database to the active location
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CURRENT_DB = '/Users/ghinkle/Library/Application Support/@nimbalyst/electron/pglite-db';
const RECOVERED_DB = '/Users/ghinkle/Library/Application Support/@nimbalyst/electron/pglite-db-old';
const BACKUP_DB = '/Users/ghinkle/Library/Application Support/@nimbalyst/electron/pglite-db-backup-' + Date.now();

async function restoreDatabase() {
  console.log('Database Restoration Script');
  console.log('='.repeat(80));
  console.log('\nThis will:');
  console.log('  1. Backup current database to:', path.basename(BACKUP_DB));
  console.log('  2. Delete current database');
  console.log('  3. Copy recovered database to active location');
  console.log('  4. Test the restored database');
  console.log('\n' + '='.repeat(80));

  try {
    // Step 1: Backup current database
    console.log('\n1. Backing up current database...');
    if (fs.existsSync(CURRENT_DB)) {
      console.log('   Copying', CURRENT_DB);
      console.log('   To', BACKUP_DB);
      execSync(`cp -R "${CURRENT_DB}" "${BACKUP_DB}"`);
      console.log('   Backup created successfully');
    } else {
      console.log('   No current database found - skipping backup');
    }

    // Step 2: Delete current database
    console.log('\n2. Removing current database...');
    if (fs.existsSync(CURRENT_DB)) {
      execSync(`rm -rf "${CURRENT_DB}"`);
      console.log('   Current database removed');
    } else {
      console.log('   No current database to remove');
    }

    // Step 3: Copy recovered database
    console.log('\n3. Copying recovered database...');
    if (!fs.existsSync(RECOVERED_DB)) {
      throw new Error('Recovered database not found at: ' + RECOVERED_DB);
    }

    console.log('   Copying', RECOVERED_DB);
    console.log('   To', CURRENT_DB);
    execSync(`cp -R "${RECOVERED_DB}" "${CURRENT_DB}"`);
    console.log('   Database copied successfully');

    // Step 4: Test the restored database
    console.log('\n4. Testing restored database...');
    const { PGlite } = require('@electric-sql/pglite');

    const db = new PGlite({
      dataDir: CURRENT_DB,
      debug: 0
    });

    await db.waitReady;
    console.log('   Database opened successfully');

    // Quick validation
    const result = await db.query('SELECT COUNT(*) as count FROM ai_sessions');
    console.log('   AI Sessions count:', result.rows[0].count);

    const historyResult = await db.query('SELECT COUNT(*) as count FROM document_history');
    console.log('   Document history count:', historyResult.rows[0].count);

    const projectResult = await db.query('SELECT COUNT(*) as count FROM project_state');
    console.log('   Project states count:', projectResult.rows[0].count);

    await db.close();

    console.log('\n' + '='.repeat(80));
    console.log('✓ Database restoration completed successfully!');
    console.log('\nYour recovered data is now active.');
    console.log('\nBackup locations:');
    console.log('  - Current backup:', BACKUP_DB);
    console.log('  - Original recovered:', RECOVERED_DB);
    console.log('\nYou can safely delete these backups once you verify everything works.');

  } catch (error) {
    console.error('\n' + '='.repeat(80));
    console.error('✗ Restoration failed:');
    console.error('  Error:', error.message);
    console.error('\nRollback:');

    if (fs.existsSync(BACKUP_DB)) {
      console.error('  Your backup is safe at:', BACKUP_DB);
      console.error('  To restore from backup, run:');
      console.error('    rm -rf "' + CURRENT_DB + '"');
      console.error('    cp -R "' + BACKUP_DB + '" "' + CURRENT_DB + '"');
    }

    process.exit(1);
  }
}

restoreDatabase().catch(console.error);
