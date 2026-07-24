# Force Restore Database from Backup

When a user's Nimbalyst database is in a bad state, they can manually restore from the most recent verified backup.

## Background

Nimbalyst maintains rolling backups of the PGLite database:
- `pglite-db.backup-current` - most recent verified backup
- `pglite-db.backup-previous` - second most recent
- `pglite-db.backup-oldest` - third most recent

Backups are created every 4 hours and verified before being stored.

## Instructions

### macOS

```bash
# 1. Quit Nimbalyst completely (Cmd+Q)

# 2. Open Terminal and navigate to the app data folder
cd ~/Library/Application\ Support/Nimbalyst

# 3. Rename the corrupted database (preserves it just in case)
mv pglite-db pglite-db.bad

# 4. Copy the most recent backup into place
cp -r db-backups/pglite-db.backup-current pglite-db

# 5. Start Nimbalyst
```

### Windows (PowerShell)

```powershell
# 1. Quit Nimbalyst completely

# 2. Open PowerShell and navigate to app data
cd "$env:APPDATA\Nimbalyst"

# 3. Rename the corrupted database
Rename-Item pglite-db pglite-db.bad

# 4. Copy the backup
Copy-Item -Recurse db-backups\pglite-db.backup-current pglite-db

# 5. Start Nimbalyst
```

### Linux

```bash
# 1. Quit Nimbalyst completely

# 2. Navigate to the config folder
cd ~/.config/Nimbalyst

# 3. Rename the corrupted database
mv pglite-db pglite-db.bad

# 4. Copy the most recent backup into place
cp -r db-backups/pglite-db.backup-current pglite-db

# 5. Start Nimbalyst
```

## Using an Older Backup

If the most recent backup is also corrupted, try an older one:

```bash
# Use the previous backup
cp -r db-backups/pglite-db.backup-previous pglite-db

# Or the oldest backup
cp -r db-backups/pglite-db.backup-oldest pglite-db
```

## What Gets Restored

The database backup contains:
- AI chat sessions and conversation history
- Document edit history (for the History sidebar)
- Session metadata and preferences

**Not affected by database issues:**
- Your actual document files (these are stored on disk separately)
- Application settings
- Workspace configurations

## Cleanup

Once you've confirmed the restore worked, you can delete the bad database:

```bash
rm -rf pglite-db.bad
```
