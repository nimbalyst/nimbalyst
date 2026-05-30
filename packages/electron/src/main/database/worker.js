/**
 * PGLite Worker Thread (JavaScript)
 * Runs PGLite in an isolated worker thread to avoid module conflicts
 *
 * CRITICAL: Date/Timestamp Handling
 * ==================================
 * All timestamp columns use TIMESTAMPTZ (timestamp with time zone).
 * With TIMESTAMPTZ, PGLite returns Date objects that already represent the
 * correct instant in time. Simply call .getTime() to get epoch milliseconds.
 *
 * Rules:
 *   1. Use TIMESTAMPTZ for all timestamp columns (not TIMESTAMP without timezone)
 *   2. PGLite Date objects are correct - just use .getTime() for epoch ms
 *   3. When writing: pass Date objects directly to TIMESTAMPTZ columns
 *   4. Display timestamps using toLocaleString() to show in user's local timezone
 */

const { parentPort, workerData } = require('worker_threads');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');
const inspector = require('node:inspector');
const { performance } = require('node:perf_hooks');
const { serializeWorkerError } = require('./workerErrorSerialization');

// ---------------------------------------------------------------------------
// CPU profile auto-capture for the PGLite worker.
// Same pattern as the SQLite worker: poll event-loop utilization, capture a
// 5s CPU profile via inspector.Session when ELU stays >= 0.8, write to the
// same logs dir as main.log. inspector.Session on main can't see this isolate,
// so without this we have no signal when PGLite pegs CPU.
// ---------------------------------------------------------------------------
const WORKER_PROFILE_TTL_MS = 60_000;
const WORKER_PROFILE_DURATION_MS = 5_000;
const WORKER_ELU_THRESHOLD = 0.8;
const WORKER_ELU_TRIGGER_SAMPLES = 2;
let pgliteProfileInFlight = false;
let pgliteLastProfileAt = 0;
let pgliteHighEluStreak = 0;

async function capturePgliteWorkerCpuProfile(triggerElu) {
  if (pgliteProfileInFlight) return;
  const now = Date.now();
  if (now - pgliteLastProfileAt < WORKER_PROFILE_TTL_MS) return;
  pgliteProfileInFlight = true;
  pgliteLastProfileAt = now;

  const session = new inspector.Session();
  try {
    session.connect();
    const post = (method, params) =>
      new Promise((resolve, reject) => {
        session.post(method, params, (err, result) => {
          if (err) reject(err); else resolve(result);
        });
      });
    await post('Profiler.enable');
    await post('Profiler.start');
    await new Promise((r) => setTimeout(r, WORKER_PROFILE_DURATION_MS));
    const { profile } = await post('Profiler.stop');

    const fs = require('fs').promises;
    const logsDir = path.join(workerData.userDataPath, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    const filename = `cpu-pglite-worker-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
    const fullPath = path.join(logsDir, filename);
    await fs.writeFile(fullPath, JSON.stringify(profile));
    console.log(`[PERF] Captured PGLite worker CPU profile (elu=${triggerElu.toFixed(2)}) -> ${fullPath}`);
  } catch (err) {
    console.log('[PERF] PGLite worker CPU profile capture failed:', err);
  } finally {
    try { session.disconnect(); } catch { /* already disconnected */ }
    pgliteProfileInFlight = false;
  }
}

function startPgliteWorkerCpuMonitor() {
  let prev = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const next = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(next, prev);
    prev = next;
    if (delta.utilization >= WORKER_ELU_THRESHOLD) {
      pgliteHighEluStreak++;
      if (pgliteHighEluStreak >= WORKER_ELU_TRIGGER_SAMPLES) {
        pgliteHighEluStreak = 0;
        capturePgliteWorkerCpuProfile(delta.utilization);
      }
    } else {
      pgliteHighEluStreak = 0;
    }
  }, 10_000);
  if (typeof timer.unref === 'function') timer.unref();
}

startPgliteWorkerCpuMonitor();

// WAL maintenance: total bytes across pg_wal/ that triggers an idle CHECKPOINT.
// Why this number: PGLite's runtime settings are min_wal_size=80MB, max_wal_size=1GB
// (verified via current_setting()). Postgres always keeps at least min_wal_size,
// so any threshold below 80MB would fire on every check. Picked 200MB so the
// trigger only fires once WAL has grown well past the floor but still well below
// the 1GB cap, avoiding the multi-hundred-MB replay cost users were hitting.
const WAL_CHECKPOINT_THRESHOLD_BYTES = 200 * 1024 * 1024;
const WAL_CHECK_INTERVAL_MS = 60 * 1000;

class PGLiteWorker {
  constructor() {
    this.db = null;
    this.dataDir = path.join(workerData.userDataPath, 'pglite-db');
    // Our own lock file with actual PID - separate from PGLite's postmaster.pid
    this.lockFilePath = path.join(workerData.userDataPath, 'nimbalyst-db.pid');
    // Counter of in-flight query/exec calls; the WAL maintenance check skips
    // when this is non-zero so a CHECKPOINT can never run during a user query
    // (--single mode serializes them anyway, but skipping avoids visibly long blocks).
    this.activeOps = 0;
    this.walMaintenanceInterval = null;
    console.log('[PGLite Worker] Worker thread instantiated, dataDir:', this.dataDir);
    this.setupMessageHandler();
  }

  /**
   * Periodic WAL maintenance. Runs only when no query/exec is in flight.
   * Reads pg_wal/ size from disk; if it exceeds the threshold, issues CHECKPOINT.
   */
  async runWalMaintenance() {
    if (!this.db) return;
    if (this.activeOps > 0) return;

    const walDir = path.join(this.dataDir, 'pg_wal');
    let totalBytes = 0;
    try {
      const fs = require('fs');
      const entries = fs.readdirSync(walDir);
      for (const name of entries) {
        try {
          const stat = fs.statSync(path.join(walDir, name));
          if (stat.isFile()) totalBytes += stat.size;
        } catch {
          // Entry vanished mid-scan; ignore.
        }
      }
    } catch (err) {
      console.warn('[PGLite Worker] WAL maintenance: could not read pg_wal/:', err?.message || err);
      return;
    }

    if (totalBytes < WAL_CHECKPOINT_THRESHOLD_BYTES) return;

    // Re-check activeOps right before issuing CHECKPOINT in case a request landed
    // between the directory read and now.
    if (this.activeOps > 0) return;

    try {
      const ckptStart = performance.now();
      await this.db.exec('CHECKPOINT');
      const elapsed = performance.now() - ckptStart;
      console.log(`[PGLite Worker] WAL maintenance CHECKPOINT (was ${(totalBytes / 1024 / 1024).toFixed(1)}MB) took ${elapsed.toFixed(0)}ms`);
    } catch (err) {
      console.warn('[PGLite Worker] WAL maintenance CHECKPOINT failed:', err?.message || err);
    }
  }

  /**
   * Acquire exclusive lock on the database using a PID file.
   * This prevents multiple Nimbalyst instances from corrupting the database.
   *
   * Lock file format:
   *   Line 1: PID of the owning process
   *   Line 2: Start timestamp (ISO format)
   *   Line 3: Hostname
   *
   * @returns {Object} { acquired: boolean, error?: Error }
   */
  acquireLock() {
    const fs = require('fs');
    const os = require('os');

    try {
      if (fs.existsSync(this.lockFilePath)) {
        // Lock file exists - check if the owning process is still running
        const lockContent = fs.readFileSync(this.lockFilePath, 'utf8');
        const lines = lockContent.split('\n');
        const lockPid = parseInt(lines[0], 10);
        const lockTimestamp = lines[1] || 'unknown';
        const lockHostname = lines[2] || 'unknown';

        if (!lockPid || isNaN(lockPid)) {
          // Invalid lock file - remove it
          console.log('[PGLite Worker] Removing invalid lock file (no valid PID)');
          fs.unlinkSync(this.lockFilePath);
        } else {
          // First, check if the system has rebooted since the lock was created.
          // If so, the PID was from a previous boot and is definitely stale --
          // even if a different process now has that PID (PID reuse after reboot).
          let isStaleFromReboot = false;
          if (lockTimestamp && lockTimestamp !== 'unknown') {
            const lockTime = new Date(lockTimestamp).getTime();
            const bootTime = Date.now() - (os.uptime() * 1000);
            if (lockTime < bootTime) {
              isStaleFromReboot = true;
              console.log(`[PGLite Worker] Lock file predates last system boot (lock: ${lockTimestamp}, boot: ${new Date(bootTime).toISOString()}) - stale from reboot`);
            }
          }

          // Check if the process is still running. The decision is
          // extracted to ./lockStaleness.js so it can be unit-tested
          // without spawning a real worker thread. See nimbalyst#272 for
          // the Windows-pid-reuse hazard the timestamp gate guards
          // against, and the closed PR #316 review thread for the
          // 'ambiguous' branch that asks the user instead of guessing.
          const { decideLockIsRunning } = require('./lockStaleness');
          let livenessDecision = 'stale';
          let livenessReason = '';
          if (isStaleFromReboot) {
            livenessDecision = 'stale';
            livenessReason = 'lock predates last reboot';
          } else {
            const result = decideLockIsRunning({
              lockPid,
              lockTimestamp,
              killFn: process.kill.bind(process),
            });
            livenessDecision = result.decision;
            livenessReason = result.reason;
            console.log(`[PGLite Worker] Lock liveness check: ${result.reason}`);
          }

          if (livenessDecision === 'running') {
            // Another instance is confirmed alive (kill(0) succeeded, OR
            // unrecognised errno). Refuse the launch unconditionally.
            const error = new Error(
              `Database is locked by another Nimbalyst process.\n\n` +
              `Lock holder PID: ${lockPid}\n` +
              `Lock acquired: ${lockTimestamp}\n` +
              `Lock host: ${lockHostname}\n\n` +
              `Please close the other instance before starting a new one, ` +
              `or data corruption may occur.`
            );
            error.code = 'DATABASE_LOCKED';
            error.lockPid = lockPid;
            return { acquired: false, error };
          }
          if (livenessDecision === 'ambiguous') {
            // EPERM with a fresh timestamp (<60s old). Either a live
            // sibling we cannot signal (different user / privilege level)
            // OR a fast PID reuse on a slow-disk machine where the
            // original lock was written less than 60s before crash.
            // Surface a distinct error code so the main process can show
            // a dialog letting the user choose between "Open Anyway"
            // (force-unlock) and "Cancel". Per @ghinkle's review on the
            // closed PR #316.
            const error = new Error(
              `Cannot tell whether another Nimbalyst is running.\n\n` +
              `Lock holder PID: ${lockPid}\n` +
              `Lock acquired: ${lockTimestamp}\n` +
              `Lock host: ${lockHostname}\n\n` +
              `Reason: ${livenessReason}`
            );
            error.code = 'DATABASE_LOCKED_AMBIGUOUS';
            error.lockPid = lockPid;
            error.lockFilePath = this.lockFilePath;
            error.lockTimestamp = lockTimestamp;
            error.lockHostname = lockHostname;
            return { acquired: false, error };
          }
          // livenessDecision === 'stale'. Process is dead, or lock
          // predates the last reboot, or EPERM with a stale timestamp.
          console.log(`[PGLite Worker] Removing stale lock file from crashed process (PID ${lockPid} no longer running)`);
          console.log(`[PGLite Worker] Previous lock was acquired at: ${lockTimestamp}`);
          fs.unlinkSync(this.lockFilePath);
        }
      }

      // Create our lock file with current process info
      const lockContent = [
        process.pid.toString(),
        new Date().toISOString(),
        os.hostname()
      ].join('\n');

      fs.writeFileSync(this.lockFilePath, lockContent, { mode: 0o644 });
      console.log(`[PGLite Worker] Acquired database lock (PID: ${process.pid})`);
      return { acquired: true };

    } catch (error) {
      if (error.code === 'DATABASE_LOCKED') {
        return { acquired: false, error };
      }
      // Unexpected error - log but try to continue
      console.error('[PGLite Worker] Error acquiring lock:', error);
      return { acquired: true }; // Proceed anyway for filesystem errors
    }
  }

  /**
   * Release the database lock by removing our PID file.
   * Only removes if we own the lock (our PID matches).
   */
  releaseLock() {
    const fs = require('fs');

    try {
      if (fs.existsSync(this.lockFilePath)) {
        // Verify we own this lock before removing
        const lockContent = fs.readFileSync(this.lockFilePath, 'utf8');
        const lockPid = parseInt(lockContent.split('\n')[0], 10);

        if (lockPid === process.pid) {
          fs.unlinkSync(this.lockFilePath);
          console.log(`[PGLite Worker] Released database lock (PID: ${process.pid})`);
        } else {
          console.warn(`[PGLite Worker] Lock file owned by different PID (${lockPid}), not removing`);
        }
      }
    } catch (error) {
      console.warn('[PGLite Worker] Error releasing lock:', error);
    }
  }

  setupMessageHandler() {
    if (!parentPort) {
      throw new Error('This module must be run in a Worker thread');
    }

    // Global error handlers for the worker
    process.on('uncaughtException', (error) => {
      console.error('[PGLite Worker] Uncaught exception:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[PGLite Worker] Unhandled rejection at:', promise, 'reason:', reason);
    });

    parentPort.on('message', async (message) => {
      try {
        const response = await this.handleMessage(message);
        parentPort.postMessage(response);
      } catch (error) {
        console.error('[PGLite Worker] Error handling message:', error);

        // ROLLBACK to clear any aborted transaction state so that
        // subsequent queries from other callers are not poisoned.
        if (this.db) {
          try {
            await this.db.exec('ROLLBACK');
          } catch {
            // Ignore - no transaction may be active
          }
        }

        parentPort.postMessage({
          id: message.id,
          success: false,
          error: error.message || String(error),
          errorData: serializeWorkerError(error)
        });
      }
    });
  }

  async handleMessage(message) {
    switch (message.type) {
      case 'init':
        return await this.initialize(message);
      case 'query':
        return await this.query(message);
      case 'queryReadOnly':
        return await this.queryReadOnly(message);
      case 'exec':
        return await this.exec(message);
      case 'close':
        return await this.close(message);
      case 'getStats':
        return await this.getStats(message);
      case 'verifyBackup':
        return await this.verifyBackup(message);
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  }

  async initialize(message) {
    const initStartTime = performance.now();
    console.log('[PGLite Worker] initialize() called, existing db:', !!this.db, 'dataDir:', this.dataDir);

    if (this.db) {
      console.log('[PGLite Worker] Database already initialized - returning early');
      return {
        id: message.id,
        success: true,
        data: { message: 'Database already initialized' }
      };
    }

    try {
      // Ensure parent directory exists (needed for test environments)
      const fs = require('fs');
      const parentDir = path.dirname(this.dataDir);
      if (!fs.existsSync(parentDir)) {
        console.log('[PGLite Worker] Creating parent directory:', parentDir);
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Check if this is a fresh database (no existing data directory)
      const isFreshDb = !fs.existsSync(this.dataDir);
      console.log('[PGLite Worker] Fresh database:', isFreshDb);

      // Acquire our exclusive lock BEFORE touching PGLite
      // This prevents multiple Nimbalyst instances from corrupting the database
      const lockStartTime = performance.now();
      const lockResult = this.acquireLock();
      console.log(`[PGLite Worker] Lock acquisition took ${(performance.now() - lockStartTime).toFixed(0)}ms`);
      if (!lockResult.acquired) {
        throw lockResult.error;
      }

      // Also clean up any stale PGLite postmaster.pid files from previous crashes
      // PGLite uses -42 as a sentinel value, not a real PID, so we can't reliably
      // detect if another PGLite instance is running from it. Our nimbalyst-db.pid
      // is the authoritative lock.
      try {
        const postmasterPidPath = path.join(this.dataDir, 'postmaster.pid');
        if (fs.existsSync(postmasterPidPath)) {
          console.log('[PGLite Worker] Removing stale postmaster.pid (our lock is authoritative)');
          fs.unlinkSync(postmasterPidPath);
        }
      } catch (e) {
        console.warn('[PGLite Worker] Could not remove stale postmaster.pid:', e.message);
      }

      // Attempt to initialize database, with automatic recovery on corruption
      let initAttempt = 0;
      const maxAttempts = 2;

      while (initAttempt < maxAttempts) {
        initAttempt++;

        try {
          // Create PGlite instance
          // Use file-based storage for persistent data
          console.log('[PGLite Worker] Creating PGlite instance at:', this.dataDir);
          const constructorStartTime = performance.now();
          this.db = new PGlite({
            dataDir: this.dataDir,
            debug: 0  // Disable PGLite debug logging
          });
          console.log(`[PGLite Worker] PGlite constructor took ${(performance.now() - constructorStartTime).toFixed(0)}ms`);

          console.log('[PGLite Worker] PGlite instance created, waiting for ready...');
          // Wait for database to be ready
          const waitReadyStartTime = performance.now();
          await this.db.waitReady;
          console.log(`[PGLite Worker] waitReady took ${(performance.now() - waitReadyStartTime).toFixed(0)}ms (fresh: ${isFreshDb})`);

          // If we get here, initialization succeeded
          break;

        } catch (dbError) {
          // Database initialization failed
          const errorStr = String(dbError?.message || dbError);
          const errorName = dbError?.name || dbError?.constructor?.name || 'UnknownError';

          console.error(`[PGLite Worker] Database initialization failed (attempt ${initAttempt}/${maxAttempts}):`, errorStr);

          // Check if this looks like corruption/abort (not a real lock)
          const isCorruptionError = errorStr.includes('Aborted') || errorName === 'RuntimeError';

          if (isCorruptionError && initAttempt < maxAttempts && fs.existsSync(this.dataDir)) {
            // Database appears corrupted - move it and try fresh
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = `${this.dataDir}.backup-${timestamp}`;

            console.log('[PGLite Worker] Database appears corrupted, moving to backup:', backupDir);
            console.log('[PGLite Worker] Creating fresh database...');

            try {
              fs.renameSync(this.dataDir, backupDir);
              console.log('[PGLite Worker] Corrupted database backed up successfully');
              console.log('[PGLite Worker] User data is preserved at:', backupDir);
              // Continue to next attempt with fresh database directory
              continue;
            } catch (backupError) {
              console.error('[PGLite Worker] Failed to backup corrupted database:', backupError);
              // Fall through to re-throw the original error
            }
          }

          // Either not a corruption error, or we failed to recover - re-throw
          throw dbError;
        }
      }

      // Create schemas
      const schemaStartTime = performance.now();
      await this.createSchemas();
      console.log(`[PGLite Worker] Schema creation took ${(performance.now() - schemaStartTime).toFixed(0)}ms`);

      // Start periodic WAL maintenance. Replaces the missing background checkpointer
      // that --single mode does not run. Only fires when activeOps === 0.
      if (this.walMaintenanceInterval) {
        clearInterval(this.walMaintenanceInterval);
      }
      this.walMaintenanceInterval = setInterval(() => {
        this.runWalMaintenance().catch((err) => {
          console.warn('[PGLite Worker] WAL maintenance threw:', err?.message || err);
        });
      }, WAL_CHECK_INTERVAL_MS);
      // Don't keep the worker alive for this timer alone.
      if (typeof this.walMaintenanceInterval.unref === 'function') {
        this.walMaintenanceInterval.unref();
      }

      // Force a CHECKPOINT after init.
      // Why: PGLite runs Postgres in --single mode, so there is no checkpointer/bgwriter
      // background process. WAL is only recycled by inline triggers, explicit CHECKPOINT,
      // or smart-shutdown. If the previous run was force-killed (e.g. because of slow
      // queries blocking shutdown), pg_wal can be huge on next launch and replay slows
      // every subsequent query down. Issuing CHECKPOINT here flushes that backlog before
      // the renderer starts hammering the DB. Non-fatal on failure.
      try {
        const ckptStart = performance.now();
        await this.db.exec('CHECKPOINT');
        console.log(`[PGLite Worker] Startup CHECKPOINT took ${(performance.now() - ckptStart).toFixed(0)}ms`);
      } catch (ckptError) {
        console.warn('[PGLite Worker] Startup CHECKPOINT failed (non-fatal):', ckptError?.message || ckptError);
      }

      // Check if we recovered from corruption
      const recovered = initAttempt > 1;

      const totalInitTime = performance.now() - initStartTime;
      console.log(`[PGLite Worker] Total initialization took ${totalInitTime.toFixed(0)}ms`);

      return {
        id: message.id,
        success: true,
        data: {
          message: recovered ? 'Database recovered from corruption' : 'Database initialized successfully',
          dataDir: this.dataDir,
          recovered: recovered,
          backupLocation: recovered ? `${this.dataDir}.backup-*` : null,
          initTimeMs: Math.round(totalInitTime)
        }
      };
    } catch (error) {
      // Capture ALL error properties for debugging
      const errorStr = String(error?.message || error);
      const errorStack = error?.stack || '';
      const errorName = error?.name || error?.constructor?.name || 'UnknownError';

      // Log full error details for diagnosis
      console.error('[PGLite Worker] Full error object:', {
        message: error?.message,
        name: errorName,
        stack: errorStack,
        code: error?.code,
        errno: error?.errno,
        syscall: error?.syscall,
        path: error?.path,
        // PGlite DatabaseError fields if present
        severity: error?.severity,
        detail: error?.detail,
        hint: error?.hint,
        // All other properties
        ...error
      });

      // Check for specific error types we can identify
      const fs = require('fs');
      let lockInfo = '';

      // Check for file system lock indicators
      try {
        const lockPath = path.join(this.dataDir, 'postmaster.pid');
        if (fs.existsSync(lockPath)) {
          lockInfo = `\n\nPostgreSQL lock file found at: ${lockPath}`;
        }
      } catch (e) {
        // Ignore lock check errors
      }

      // Check if database directory is accessible
      let accessInfo = '';
      try {
        fs.accessSync(this.dataDir, fs.constants.R_OK | fs.constants.W_OK);
      } catch (e) {
        accessInfo = `\n\nDirectory access error: ${e.message}`;
      }

      // Detect specific error patterns
      if (errorStr.includes('Aborted') || errorName === 'RuntimeError') {
        // WebAssembly abort - likely file lock or corruption
        throw new Error(
          `DATABASE_INIT_FAILED: WebAssembly abort during PGlite initialization\n\n` +
          `Database path: ${this.dataDir}\n` +
          `Error: ${errorStr}\n` +
          lockInfo +
          accessInfo +
          `\n\nThis usually indicates:\n` +
          `1. Another process has the database locked\n` +
          `2. Database files are corrupted\n` +
          `3. Insufficient file system permissions\n` +
          `\nStack trace:\n${errorStack}`
        );
      }

      if (error?.code === 'EBUSY' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        // File system permission/lock error
        throw new Error(
          `DATABASE_LOCKED: File system error (${error.code})\n\n` +
          `Database path: ${this.dataDir}\n` +
          `Syscall: ${error.syscall || 'unknown'}\n` +
          `Target: ${error.path || 'unknown'}\n` +
          lockInfo +
          `\n\nAnother process is using this database or you lack permissions.`
        );
      }

      // Generic error with full context
      throw new Error(
        `Failed to initialize PGlite\n\n` +
        `Database path: ${this.dataDir}\n` +
        `Error type: ${errorName}\n` +
        `Error: ${errorStr}\n` +
        (error?.code ? `Code: ${error.code}\n` : '') +
        lockInfo +
        accessInfo +
        `\n\nStack trace:\n${errorStack}`
      );
    }
  }


  async createSchemas() {
    if (!this.db) throw new Error('Database not initialized');

    // AI Sessions table
    // IMPORTANT: Use TIMESTAMPTZ (not TIMESTAMP) for all timestamp columns
    // PGLite misinterprets Date objects for TIMESTAMP columns, adding local timezone offset
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT 'default',
        file_path TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        title TEXT NOT NULL DEFAULT 'New conversation',
        session_type TEXT DEFAULT 'session',
        agent_role TEXT DEFAULT 'standard',
        created_by_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL,
        document_context JSONB,
        provider_config JSONB,
        provider_session_id TEXT,
        draft_input TEXT,
        metadata JSONB DEFAULT '{}',
        last_read_message_id TEXT,
        last_read_timestamp TIMESTAMPTZ,
        has_been_named BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_ai_sessions_workspace ON ai_sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_created ON ai_sessions(created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_type ON ai_sessions(session_type);
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated ON ai_sessions(updated_at);

      -- One-time fix: Ensure all sessions have updated_at set to at least created_at
      -- This fixes sessions created before updated_at tracking was working properly
      UPDATE ai_sessions
      SET updated_at = created_at
      WHERE updated_at < created_at OR updated_at IS NULL;
    `);

    // Add read state columns to existing ai_sessions tables (migration)
    await this.db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'last_read_message_id'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN last_read_message_id TEXT;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'last_read_timestamp'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN last_read_timestamp TIMESTAMPTZ;
        END IF;

        -- Add session state tracking columns (migration)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'status'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'waiting_for_input', 'error'));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'last_activity'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN last_activity TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'has_been_named'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN has_been_named BOOLEAN DEFAULT FALSE;
        END IF;

        -- Add mode column for session behavior (planning vs agent)
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'mode'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN mode TEXT DEFAULT 'agent' CHECK (mode IN ('planning', 'agent'));
        END IF;

        -- Add is_archived column for session archiving feature
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'is_archived'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN is_archived BOOLEAN DEFAULT FALSE;
        END IF;

        -- Add last_document_state column for DocumentContextService persistence
        -- Stores {filePath, contentHash} to enable transition detection across restarts
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ai_sessions' AND column_name = 'last_document_state'
        ) THEN
          ALTER TABLE ai_sessions ADD COLUMN last_document_state JSONB;
        END IF;
      END $$;
    `);

    // Migration: Simplify session status states -- drop 'interrupted' (it's just 'idle')
    // Update any existing 'interrupted' rows to 'idle', then replace the CHECK constraint.
    await this.db.exec(`
      UPDATE ai_sessions SET status = 'idle' WHERE status = 'interrupted';
    `);
    await this.db.exec(`
      DO $$
      DECLARE
        constraint_name TEXT;
      BEGIN
        SELECT con.conname INTO constraint_name
        FROM pg_constraint con
        JOIN pg_attribute att ON att.attnum = ANY(con.conkey) AND att.attrelid = con.conrelid
        WHERE con.conrelid = 'ai_sessions'::regclass
          AND att.attname = 'status'
          AND con.contype = 'c';
        IF constraint_name IS NOT NULL THEN
          EXECUTE 'ALTER TABLE ai_sessions DROP CONSTRAINT ' || constraint_name;
          ALTER TABLE ai_sessions ADD CONSTRAINT ai_sessions_status_check
            CHECK (status IN ('idle', 'running', 'waiting_for_input', 'error'));
        END IF;
      END $$;
    `);

    // Create index for archived sessions filtering
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_archived ON ai_sessions(is_archived);
    `);

    // Document History table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_history (
        id SERIAL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content BYTEA NOT NULL,
        size_bytes INTEGER,
        timestamp BIGINT NOT NULL,
        version INTEGER DEFAULT 1,
        metadata JSONB DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_history_workspace_file ON document_history(workspace_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_history_timestamp ON document_history(timestamp);

      -- Create index to speed up duplicate detection (most recent snapshot check)
      -- This is just for performance, not uniqueness
      CREATE INDEX IF NOT EXISTS idx_history_file_content_hash
        ON document_history(file_path, (metadata->>'baseMarkdownHash'))
        WHERE metadata->>'baseMarkdownHash' IS NOT NULL;

      -- Migration: Clean up duplicate pending tags before creating unique index
      -- Keep only the most recent pending tag per file (any type)
      DELETE FROM document_history
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY file_path
                   ORDER BY timestamp DESC
                 ) as rn
          FROM document_history
          WHERE metadata->>'status' = 'pending-review'
        ) t
        WHERE rn > 1
      );

      -- Drop old separate indexes if they exist
      DROP INDEX IF EXISTS idx_history_pending_pre_edit_per_file;
      DROP INDEX IF EXISTS idx_history_pending_incremental_approval_per_file;

      -- CRITICAL: Only ONE tag with status='pending-review' per file at a time
      -- This ensures unambiguous diff baseline and prevents multiple pending tags
      -- Applies to ALL tag types (pre-edit, incremental-approval, etc.)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_history_one_pending_per_file
        ON document_history(file_path)
        WHERE metadata->>'status' = 'pending-review';
    `);

    // Session Files table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_files (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        link_type TEXT NOT NULL CHECK (link_type IN ('edited', 'referenced', 'read')),
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_files_file ON session_files(file_path);
      CREATE INDEX IF NOT EXISTS idx_session_files_type ON session_files(link_type);
      CREATE INDEX IF NOT EXISTS idx_session_files_workspace ON session_files(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_session_files_workspace_file ON session_files(workspace_id, file_path);
      CREATE INDEX IF NOT EXISTS idx_session_files_unique ON session_files(session_id, file_path, link_type);
      -- Optimized index for "latest session per file" lookup
      -- (ROW_NUMBER() OVER PARTITION BY file_path ORDER BY timestamp DESC)
      CREATE INDEX IF NOT EXISTS idx_session_files_uncommitted_lookup ON session_files(workspace_id, link_type, file_path, timestamp DESC);
    `);

    // AI Agent Messages table - write-only raw storage for AI interactions
    // NOTE: Must be created BEFORE ai_tool_call_file_edits which has a FK to this table
    console.log('[PGLite Worker] Creating ai_agent_messages table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS ai_agent_messages (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          source TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
          content TEXT NOT NULL,
          metadata JSONB,
          CONSTRAINT fk_ai_agent_messages_session
            FOREIGN KEY (session_id)
            REFERENCES ai_sessions(id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_session ON ai_agent_messages(session_id, id);
        CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_created ON ai_agent_messages(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_source_direction ON ai_agent_messages(source, direction);
      `);
      console.log('[PGLite Worker] ai_agent_messages table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create ai_agent_messages table:', error);
      throw error;
    }

    // Add hidden column to ai_agent_messages table (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_agent_messages' AND column_name = 'hidden'
          ) THEN
            ALTER TABLE ai_agent_messages ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT FALSE;
          END IF;
        END $$;
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to add hidden column:', error);
      throw error;
    }

    // Add provider_message_id column to ai_agent_messages table (migration)
    // This stores the provider-assigned message ID (e.g., SDK uuid) for sync deduplication
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_agent_messages' AND column_name = 'provider_message_id'
          ) THEN
            ALTER TABLE ai_agent_messages ADD COLUMN provider_message_id TEXT;
          END IF;
        END $$;
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to add provider_message_id column:', error);
      throw error;
    }

    // Add searchable column to ai_agent_messages table (migration)
    // This marks which messages should be included in FTS index (user prompts, assistant text)
    // Tool results, system events, etc. are not searchable to keep index small and fast
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_agent_messages' AND column_name = 'searchable'
          ) THEN
            ALTER TABLE ai_agent_messages ADD COLUMN searchable BOOLEAN NOT NULL DEFAULT FALSE;
          END IF;
        END $$;
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to add searchable column:', error);
      throw error;
    }

    // NOTE: We used to drop the old FTS index here unconditionally, but that was wrong
    // because it would drop the index that the user just built via the dialog.
    // The old non-partial index (without WHERE searchable = true) is no longer created,
    // so there's nothing to migrate from. If users have the old index, they can rebuild it.

    // Add GIN index for full-text search on searchable messages only
    // This dramatically speeds up FTS queries by only indexing user prompts and assistant text
    // Only create eagerly for SMALL databases - large databases will prompt user via dialog
    try {
      const searchableResult = await this.db.query('SELECT COUNT(*) as count FROM ai_agent_messages WHERE searchable = true');
      const searchableCount = parseInt(searchableResult.rows[0]?.count || '0');

      const totalResult = await this.db.query('SELECT COUNT(*) as count FROM ai_agent_messages');
      const totalCount = parseInt(totalResult.rows[0]?.count || '0');

      // Check if backfill is needed: many messages but very few are searchable (<5% ratio)
      const searchableRatio = totalCount > 0 ? searchableCount / totalCount : 1;
      const needsBackfill = totalCount > 1000 && searchableRatio < 0.05;

      if (needsBackfill) {
        // Don't create index yet - user will trigger backfill + index build via dialog
        console.log(`[PGLite Worker] Backfill needed (${searchableCount} searchable of ${totalCount} total, ${(searchableRatio * 100).toFixed(1)}%), will prompt user later`);
      } else if (searchableCount < 1000) {
        // Safe to create index eagerly - will be fast for small/new databases
        await this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_content_fts
          ON ai_agent_messages USING GIN(to_tsvector('english', content))
          WHERE searchable = true
        `);
        console.log('[PGLite Worker] FTS GIN index created successfully (searchable messages only)');
      } else {
        // Large database with backfill already done - prompt user via dialog to build index
        console.log(`[PGLite Worker] Skipping FTS index creation at startup (${searchableCount} searchable messages), will prompt user when they search`);
      }
    } catch (error) {
      // Non-fatal: searches will still work, just slower without the index
      console.warn('[PGLite Worker] Failed to create FTS GIN index:', error);
    }

    // AI Tool Call <-> File Edit linkage table
    // Maps session_files entries to the ai_agent_messages tool call that caused them
    console.log('[PGLite Worker] Creating ai_tool_call_file_edits table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS ai_tool_call_file_edits (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          session_file_id TEXT NOT NULL,
          message_id BIGINT NOT NULL,
          tool_call_item_id TEXT,
          tool_use_id TEXT,
          match_score INTEGER NOT NULL DEFAULT 0,
          match_reason TEXT,
          file_timestamp TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_atcfe_session FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
          CONSTRAINT fk_atcfe_session_file FOREIGN KEY (session_file_id) REFERENCES session_files(id) ON DELETE CASCADE,
          CONSTRAINT fk_atcfe_message FOREIGN KEY (message_id) REFERENCES ai_agent_messages(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_atcfe_session ON ai_tool_call_file_edits(session_id);
        CREATE INDEX IF NOT EXISTS idx_atcfe_session_file ON ai_tool_call_file_edits(session_file_id);
        CREATE INDEX IF NOT EXISTS idx_atcfe_message ON ai_tool_call_file_edits(message_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_atcfe_unique ON ai_tool_call_file_edits(session_file_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_atcfe_session_tool_call ON ai_tool_call_file_edits(session_id, tool_call_item_id);
      `);
      console.log('[PGLite Worker] ai_tool_call_file_edits table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create ai_tool_call_file_edits table:', error);
      throw error;
    }

    // Tracker Items table (JSONB structure)
    console.log('[PGLite Worker] Creating tracker_items table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS tracker_items (
          id TEXT PRIMARY KEY,
          issue_number INTEGER,
          issue_key TEXT,
          type TEXT NOT NULL,
          data JSONB NOT NULL,
          workspace TEXT NOT NULL,
          document_path TEXT,
          line_number INTEGER,
          created TIMESTAMPTZ DEFAULT NOW(),
          updated TIMESTAMPTZ DEFAULT NOW(),
          last_indexed TIMESTAMPTZ DEFAULT NOW(),
          title TEXT GENERATED ALWAYS AS (data->>'title') STORED,
          status TEXT GENERATED ALWAYS AS (data->>'status') STORED
        );

        CREATE INDEX IF NOT EXISTS idx_tracker_type ON tracker_items(type);
        CREATE INDEX IF NOT EXISTS idx_tracker_workspace ON tracker_items(workspace);
        CREATE INDEX IF NOT EXISTS idx_tracker_status ON tracker_items(status);
        CREATE INDEX IF NOT EXISTS idx_tracker_created ON tracker_items(created);
        CREATE INDEX IF NOT EXISTS idx_tracker_updated ON tracker_items(updated);
        CREATE INDEX IF NOT EXISTS idx_tracker_data_gin ON tracker_items USING GIN(data);
      `);
      // console.log('[PGLite Worker] tracker_items table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create tracker_items table:', error);
      throw error;
    }

    // Migration: Handle old tracker_items schema (pre-v0.44.0)
    // Old schema used flat columns with 'module TEXT' instead of JSONB 'data' + 'document_path'
    // Since tracker items are transient (re-indexed from documents), we drop and recreate if needed
    try {
      const result = await this.db.query(`
        SELECT
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tracker_items' AND column_name = 'module') as has_module,
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tracker_items' AND column_name = 'data') as has_data,
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tracker_items' AND column_name = 'document_path') as has_document_path
      `);

      const { has_module, has_data, has_document_path } = result.rows[0] || {};

      if (has_module && !has_document_path) {
        if (!has_data) {
          // Old flat schema without JSONB - drop and recreate
          console.log('[PGLite Worker] Detected old tracker_items schema (flat, no JSONB). Dropping and recreating...');
          await this.db.exec(`DROP TABLE IF EXISTS tracker_items CASCADE`);
          await this.db.exec(`
            CREATE TABLE tracker_items (
              id TEXT PRIMARY KEY,
              issue_number INTEGER,
              issue_key TEXT,
              type TEXT NOT NULL,
              data JSONB NOT NULL,
              workspace TEXT NOT NULL,
              document_path TEXT,
              line_number INTEGER,
              created TIMESTAMPTZ DEFAULT NOW(),
              updated TIMESTAMPTZ DEFAULT NOW(),
              last_indexed TIMESTAMPTZ DEFAULT NOW(),
              title TEXT GENERATED ALWAYS AS (data->>'title') STORED,
              status TEXT GENERATED ALWAYS AS (data->>'status') STORED
            );

            CREATE INDEX IF NOT EXISTS idx_tracker_type ON tracker_items(type);
            CREATE INDEX IF NOT EXISTS idx_tracker_workspace ON tracker_items(workspace);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_number ON tracker_items(workspace, issue_number) WHERE issue_number IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_key ON tracker_items(workspace, issue_key) WHERE issue_key IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_tracker_status ON tracker_items(status);
            CREATE INDEX IF NOT EXISTS idx_tracker_created ON tracker_items(created);
            CREATE INDEX IF NOT EXISTS idx_tracker_updated ON tracker_items(updated);
            CREATE INDEX IF NOT EXISTS idx_tracker_data_gin ON tracker_items USING GIN(data);
          `);
          console.log('[PGLite Worker] Recreated tracker_items table with new schema');
        } else {
          // Has JSONB data but wrong column name - just rename
          console.log('[PGLite Worker] Renaming tracker_items.module -> document_path');
          await this.db.exec(`
            ALTER TABLE tracker_items RENAME COLUMN module TO document_path;
            DROP INDEX IF EXISTS idx_tracker_items_module;
          `);
          console.log('[PGLite Worker] Renamed tracker_items column successfully');
        }
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to migrate tracker_items schema:', error);
      // Non-fatal - tracker items will be re-indexed from documents anyway
    }

    // Migration: Add sync_status column for collaborative tracker sync
      try {
          const syncStatusCheck = await this.db.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tracker_items' AND column_name = 'sync_status'
        ) as has_sync_status
      `);
          const { has_sync_status } = syncStatusCheck.rows[0] || {};
          if (!has_sync_status) {
              console.log('[PGLite Worker] Adding sync_status column to tracker_items...');
              await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN sync_status TEXT DEFAULT 'local';
          CREATE INDEX IF NOT EXISTS idx_tracker_sync_status ON tracker_items(sync_status);
        `);
              console.log('[PGLite Worker] Added sync_status column to tracker_items');
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to add sync_status column:', error);
      // Non-fatal - new column defaults are safe
    }

    // Migration: Add human-readable issue key columns for shared trackers
    try {
      const issueIdentityCheck = await this.db.query(`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tracker_items' AND column_name = 'issue_number'
          ) as has_issue_number,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tracker_items' AND column_name = 'issue_key'
          ) as has_issue_key
      `);
      const { has_issue_number, has_issue_key } = issueIdentityCheck.rows[0] || {};
      if (!has_issue_number) {
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN issue_number INTEGER;
        `);
      }
      if (!has_issue_key) {
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN issue_key TEXT;
        `);
      }
      // Always ensure indexes exist (covers both new DBs and migrated DBs)
      await this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_number ON tracker_items(workspace, issue_number) WHERE issue_number IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tracker_workspace_issue_key ON tracker_items(workspace, issue_key) WHERE issue_key IS NOT NULL;
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to add issue identity columns:', error);
    }

    // Migration: Add content, archived, source columns for unified tracker system
    try {
      const unifiedCheck = await this.db.query(`
        SELECT
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tracker_items' AND column_name = 'content') as has_content,
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tracker_items' AND column_name = 'archived') as has_archived,
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tracker_items' AND column_name = 'source') as has_source
      `);
      const { has_content, has_archived, has_source } = unifiedCheck.rows[0] || {};
      if (!has_content) {
        console.log('[PGLite Worker] Adding unified tracker columns to tracker_items...');
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN content JSONB;
          ALTER TABLE tracker_items ADD COLUMN archived BOOLEAN DEFAULT FALSE;
          ALTER TABLE tracker_items ADD COLUMN archived_at TIMESTAMPTZ;
          ALTER TABLE tracker_items ADD COLUMN source TEXT DEFAULT 'inline';
          ALTER TABLE tracker_items ADD COLUMN source_ref TEXT;
          CREATE INDEX IF NOT EXISTS idx_tracker_archived ON tracker_items(archived);
          CREATE INDEX IF NOT EXISTS idx_tracker_source ON tracker_items(source);
        `);
        console.log('[PGLite Worker] Added unified tracker columns to tracker_items');
      } else {
        // Individual column checks for partial migrations
        if (!has_archived) {
          await this.db.exec(`
            ALTER TABLE tracker_items ADD COLUMN archived BOOLEAN DEFAULT FALSE;
            ALTER TABLE tracker_items ADD COLUMN archived_at TIMESTAMPTZ;
            CREATE INDEX IF NOT EXISTS idx_tracker_archived ON tracker_items(archived);
          `);
        }
        if (!has_source) {
          await this.db.exec(`
            ALTER TABLE tracker_items ADD COLUMN source TEXT DEFAULT 'inline';
            ALTER TABLE tracker_items ADD COLUMN source_ref TEXT;
            CREATE INDEX IF NOT EXISTS idx_tracker_source ON tracker_items(source);
          `);
        }
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to add unified tracker columns:', error);
      // Non-fatal
    }

    // Migration: Add type_tags TEXT[] column for multi-type tracker items
    try {
      const typeTagsCheck = await this.db.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tracker_items' AND column_name = 'type_tags'
        ) as has_type_tags
      `);
      const { has_type_tags } = typeTagsCheck.rows[0] || {};
      if (!has_type_tags) {
        console.log('[PGLite Worker] Adding type_tags column to tracker_items...');
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN type_tags TEXT[] DEFAULT '{}';
          CREATE INDEX IF NOT EXISTS idx_tracker_type_tags ON tracker_items USING GIN(type_tags);
        `);
        // Backfill: set type_tags = ARRAY[type] for all existing rows
        await this.db.exec(`
          UPDATE tracker_items SET type_tags = ARRAY[type] WHERE type_tags = '{}' OR type_tags IS NULL;
        `);
        console.log('[PGLite Worker] Added type_tags column and backfilled from type');
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to add type_tags column:', error);
      // Non-fatal
    }

    // Migration: Add kanban_sort_order generated column for manual card ordering
    try {
      const sortOrderCheck = await this.db.query(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'tracker_items' AND column_name = 'kanban_sort_order'
        ) as has_kanban_sort_order
      `);
      const { has_kanban_sort_order } = sortOrderCheck.rows[0] || {};
      if (!has_kanban_sort_order) {
        console.log('[PGLite Worker] Adding kanban_sort_order column to tracker_items...');
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN kanban_sort_order TEXT
            GENERATED ALWAYS AS (data->>'kanbanSortOrder') STORED;
          CREATE INDEX IF NOT EXISTS idx_tracker_kanban_sort
            ON tracker_items(workspace, status, kanban_sort_order);
        `);
      }

      // Backfill: assign sort keys to any items missing them (runs every startup).
      // Uses row_number to generate ascending keys per workspace, preserving last_indexed order.
      const missingCount = await this.db.query(`
        SELECT COUNT(*) as cnt FROM tracker_items WHERE data->>'kanbanSortOrder' IS NULL
      `);
      if (missingCount.rows[0]?.cnt > 0) {
        console.log('[PGLite Worker] Backfilling', missingCount.rows[0].cnt, 'items with kanbanSortOrder...');
        await this.db.exec(`
          UPDATE tracker_items SET data = jsonb_set(
            data,
            '{kanbanSortOrder}',
            to_jsonb('a' || lpad(rn::text, 4, '0'))
          )
          FROM (
            SELECT id, row_number() OVER (PARTITION BY workspace ORDER BY last_indexed DESC) - 1 AS rn
            FROM tracker_items
            WHERE data->>'kanbanSortOrder' IS NULL
          ) sub
          WHERE tracker_items.id = sub.id;
        `);
        console.log('[PGLite Worker] Backfill complete');
      }

      // Fix-up: promote customFields.kanbanSortOrder to top-level data.kanbanSortOrder
      const nestedCount = await this.db.query(`
        SELECT COUNT(*) as cnt FROM tracker_items
        WHERE data->'customFields'->>'kanbanSortOrder' IS NOT NULL
          AND data->>'kanbanSortOrder' IS NULL
      `);
      if (nestedCount.rows[0]?.cnt > 0) {
        console.log('[PGLite Worker] Promoting', nestedCount.rows[0].cnt, 'nested kanbanSortOrder values...');
        await this.db.exec(`
          UPDATE tracker_items SET data = jsonb_set(
            data - 'customFields',
            '{kanbanSortOrder}',
            data->'customFields'->'kanbanSortOrder'
          )
          WHERE data->'customFields'->>'kanbanSortOrder' IS NOT NULL
            AND data->>'kanbanSortOrder' IS NULL;
        `);
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to add kanban_sort_order column:', error);
      // Non-fatal
    }

    // ========================================================================
    // tracker-sync-redesign D9: metadata-layer schema reshape
    // ========================================================================
    //
    // Drops the v1 field-stamp LWW model (`_fieldUpdatedAt` inside `data`)
    // and adds the columns the metadata sync layer expects:
    //   - sync_id BIGINT: server-assigned monotonic version of the most
    //     recent accepted mutation for this row. Drives delta queries.
    //   - body_version BIGINT: pointer to the most recent body Y.Doc
    //     snapshot in DocumentRoom. Bumped on every body write; used to
    //     invalidate `tracker_body_cache`.
    //   - deleted_at TIMESTAMPTZ: tombstone marker. Rows with deleted_at
    //     set are hidden from queries but kept so the engine can replay
    //     deltas without re-fetching.
    //
    // Per the design doc's "delete decisively" guidance, the migration
    // unconditionally strips `_fieldUpdatedAt` from `data`. Backwards
    // compatibility for the v1 protocol is intentionally not preserved.
    try {
      const trackerSyncIdCheck = await this.db.query(`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tracker_items' AND column_name = 'sync_id'
          ) as has_sync_id,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tracker_items' AND column_name = 'body_version'
          ) as has_body_version,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tracker_items' AND column_name = 'deleted_at'
          ) as has_deleted_at
      `);
      const {
        has_sync_id: hasSyncIdCol,
        has_body_version: hasBodyVersionCol,
        has_deleted_at: hasDeletedAtCol,
      } = trackerSyncIdCheck.rows[0] || {};

      if (!hasSyncIdCol) {
        console.log('[PGLite Worker] Adding sync_id to tracker_items (tracker-sync-redesign D9)...');
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN sync_id BIGINT;
          CREATE INDEX IF NOT EXISTS idx_tracker_workspace_sync_id ON tracker_items(workspace, sync_id);
        `);
      }
      if (!hasBodyVersionCol) {
        console.log('[PGLite Worker] Adding body_version to tracker_items...');
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN body_version BIGINT NOT NULL DEFAULT 0;
        `);
      }
      if (!hasDeletedAtCol) {
        console.log('[PGLite Worker] Adding deleted_at to tracker_items...');
        await this.db.exec(`
          ALTER TABLE tracker_items ADD COLUMN deleted_at TIMESTAMPTZ;
          CREATE INDEX IF NOT EXISTS idx_tracker_deleted_at ON tracker_items(deleted_at) WHERE deleted_at IS NOT NULL;
        `);
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to add D9 sync columns:', error);
      throw error;
    }

    // Strip `_fieldUpdatedAt` from every `data` JSONB. The new architecture
    // orders writes by server-assigned `sync_id` -- the per-field timestamp
    // map is dead weight that the old upload path used to forge. Run on
    // every startup; cheap when there's nothing to strip.
    try {
      const staleStampCount = await this.db.query(`
        SELECT COUNT(*) as cnt FROM tracker_items
        WHERE data ? '_fieldUpdatedAt'
      `);
      if (staleStampCount.rows[0]?.cnt > 0) {
        console.log(
          '[PGLite Worker] Stripping _fieldUpdatedAt from',
          staleStampCount.rows[0].cnt,
          'tracker_items rows (D9 cleanup)...',
        );
        await this.db.exec(`
          UPDATE tracker_items SET data = data - '_fieldUpdatedAt'
          WHERE data ? '_fieldUpdatedAt';
        `);
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to strip _fieldUpdatedAt:', error);
      // Non-fatal; the new client engine ignores the key.
    }

    // Body cache for cold reads (full-text search, no-roundtrip detail open).
    // Populated by phase 4 (Body Y.Doc cache). Phase 1 just provisions the
    // schema so the projection target exists before any code reaches for it.
    console.log('[PGLite Worker] Creating tracker_body_cache table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS tracker_body_cache (
          item_id TEXT NOT NULL,
          body_version BIGINT NOT NULL,
          content TEXT NOT NULL,
          cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (item_id, body_version)
        );
        CREATE INDEX IF NOT EXISTS idx_tracker_body_cache_item ON tracker_body_cache(item_id);
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to create tracker_body_cache table:', error);
      throw error;
    }

    // Offline transaction queue. Linear's four-state model (D6):
    //   created -> queued -> executing -> persistedEnqueue.
    // Phase 3 (client engine) reads/writes this; the renderer never
    // touches it directly.
    console.log('[PGLite Worker] Creating tracker_transactions table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS tracker_transactions (
          client_mutation_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('created','queued','executing','persistedEnqueue')),
          kind TEXT NOT NULL CHECK (kind IN ('create','update','delete')),
          payload JSONB,
          enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          confirmed_sync_id BIGINT,
          last_rejection JSONB
        );
        CREATE INDEX IF NOT EXISTS idx_tracker_txn_workspace_state ON tracker_transactions(workspace_path, state);
        CREATE INDEX IF NOT EXISTS idx_tracker_txn_item ON tracker_transactions(item_id);
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to create tracker_transactions table:', error);
      throw error;
    }

    // AI Agent Messages table - write-only raw storage for AI interactions
    console.log('[PGLite Worker] Creating ai_agent_messages table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS ai_agent_messages (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          source TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
          content TEXT NOT NULL,
          metadata JSONB,
          CONSTRAINT fk_ai_agent_messages_session
            FOREIGN KEY (session_id)
            REFERENCES ai_sessions(id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_session ON ai_agent_messages(session_id, id);
        CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_created ON ai_agent_messages(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_source_direction ON ai_agent_messages(source, direction);
      `);
      console.log('[PGLite Worker] ai_agent_messages table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create ai_agent_messages table:', error);
      throw error;
    }

    // Add hidden column to ai_agent_messages table (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_agent_messages' AND column_name = 'hidden'
          ) THEN
            ALTER TABLE ai_agent_messages ADD COLUMN hidden BOOLEAN NOT NULL DEFAULT FALSE;
          END IF;
        END $$;
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to add hidden column:', error);
      throw error;
    }

    // Add provider_message_id column to ai_agent_messages table (migration)
    // This stores the provider-assigned message ID (e.g., SDK uuid) for sync deduplication
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_agent_messages' AND column_name = 'provider_message_id'
          ) THEN
            ALTER TABLE ai_agent_messages ADD COLUMN provider_message_id TEXT;
          END IF;
        END $$;
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to add provider_message_id column:', error);
      throw error;
    }

    // Add searchable column to ai_agent_messages table (migration)
    // This marks which messages should be included in FTS index (user prompts, assistant text)
    // Tool results, system events, etc. are not searchable to keep index small and fast
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_agent_messages' AND column_name = 'searchable'
          ) THEN
            ALTER TABLE ai_agent_messages ADD COLUMN searchable BOOLEAN NOT NULL DEFAULT FALSE;
          END IF;
        END $$;
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to add searchable column:', error);
      throw error;
    }

    // NOTE: We used to drop the old FTS index here unconditionally, but that was wrong
    // because it would drop the index that the user just built via the dialog.
    // The old non-partial index (without WHERE searchable = true) is no longer created,
    // so there's nothing to migrate from. If users have the old index, they can rebuild it.

    // Add GIN index for full-text search on searchable messages only
    // This dramatically speeds up FTS queries by only indexing user prompts and assistant text
    // Only create eagerly for SMALL databases - large databases will prompt user via dialog
    try {
      const searchableResult = await this.db.query('SELECT COUNT(*) as count FROM ai_agent_messages WHERE searchable = true');
      const searchableCount = parseInt(searchableResult.rows[0]?.count || '0');

      const totalResult = await this.db.query('SELECT COUNT(*) as count FROM ai_agent_messages');
      const totalCount = parseInt(totalResult.rows[0]?.count || '0');

      // Check if backfill is needed: many messages but very few are searchable (<5% ratio)
      const searchableRatio = totalCount > 0 ? searchableCount / totalCount : 1;
      const needsBackfill = totalCount > 1000 && searchableRatio < 0.05;

      if (needsBackfill) {
        // Don't create index yet - user will trigger backfill + index build via dialog
        console.log(`[PGLite Worker] Backfill needed (${searchableCount} searchable of ${totalCount} total, ${(searchableRatio * 100).toFixed(1)}%), will prompt user later`);
      } else if (searchableCount < 1000) {
        // Safe to create index eagerly - will be fast for small/new databases
          await this.db.exec(`
          CREATE INDEX IF NOT EXISTS idx_ai_agent_messages_content_fts
          ON ai_agent_messages USING GIN(to_tsvector('english', content))
          WHERE searchable = true
          `);
        console.log('[PGLite Worker] FTS GIN index created successfully (searchable messages only)');
      } else {
        // Large database with backfill already done - prompt user via dialog to build index
        console.log(`[PGLite Worker] Skipping FTS index creation at startup (${searchableCount} searchable messages), will prompt user when they search`);
      }
    } catch (error) {
      // Non-fatal: searches will still work, just slower without the index
      console.warn('[PGLite Worker] Failed to create FTS GIN index:', error);
    }

    // Queued Prompts table - stores prompts queued from any device for execution
    // Uses simple row-level atomic updates instead of JSONB array manipulation
    console.log('[PGLite Worker] Creating queued_prompts table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS queued_prompts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
          attachments JSONB,
          document_context JSONB,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          claimed_at TIMESTAMPTZ,
          completed_at TIMESTAMPTZ,
          error_message TEXT,
          CONSTRAINT fk_queued_prompts_session
            FOREIGN KEY (session_id)
            REFERENCES ai_sessions(id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_queued_prompts_session ON queued_prompts(session_id);
        CREATE INDEX IF NOT EXISTS idx_queued_prompts_status ON queued_prompts(status);
        CREATE INDEX IF NOT EXISTS idx_queued_prompts_session_status ON queued_prompts(session_id, status);
        CREATE INDEX IF NOT EXISTS idx_queued_prompts_created ON queued_prompts(created_at);
      `);
      console.log('[PGLite Worker] queued_prompts table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create queued_prompts table:', error);
      throw error;
    }

    // Session Wakeups table - scheduled re-invocations of an AI session
    // Persists across app restarts; scheduler in main process arms a single setTimeout
    console.log('[PGLite Worker] Creating ai_session_wakeups table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS ai_session_wakeups (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          prompt TEXT NOT NULL,
          reason TEXT,
          fire_at TIMESTAMPTZ NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','firing','fired','waiting_for_workspace','overdue','cancelled','failed')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          fired_at TIMESTAMPTZ,
          error TEXT,
          CONSTRAINT fk_session_wakeups_session
            FOREIGN KEY (session_id)
            REFERENCES ai_sessions(id)
            ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_session_wakeups_pending_fire_at
          ON ai_session_wakeups(fire_at)
          WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS idx_session_wakeups_session
          ON ai_session_wakeups(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_wakeups_workspace
          ON ai_session_wakeups(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_session_wakeups_waiting
          ON ai_session_wakeups(workspace_id)
          WHERE status = 'waiting_for_workspace';
      `);
      console.log('[PGLite Worker] ai_session_wakeups table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create ai_session_wakeups table:', error);
      throw error;
    }

    // Worktrees table - stores git worktree metadata
    console.log('[PGLite Worker] Creating worktrees table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS worktrees (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          branch TEXT NOT NULL,
          base_branch TEXT DEFAULT 'main',
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_worktrees_path ON worktrees(path);
      `);
      console.log('[PGLite Worker] worktrees table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create worktrees table:', error);
      throw error;
    }

    // Add worktree_id column to ai_sessions (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'worktree_id'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL;
          END IF;
        END $$;
      `);

      // Create index for worktree sessions
      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_worktree ON ai_sessions(worktree_id);
      `);

      console.log('[PGLite Worker] worktree_id column added to ai_sessions');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add worktree_id column:', error);
      throw error;
    }

    // Add display_name column to worktrees (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'worktrees' AND column_name = 'display_name'
          ) THEN
            ALTER TABLE worktrees ADD COLUMN display_name TEXT;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] display_name column added to worktrees');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add display_name column:', error);
      throw error;
    }

    // Add is_pinned column to ai_sessions (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'is_pinned'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN is_pinned BOOLEAN DEFAULT FALSE;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] is_pinned column added to ai_sessions');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add is_pinned column to ai_sessions:', error);
      throw error;
    }

    // Add is_pinned column to worktrees (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'worktrees' AND column_name = 'is_pinned'
          ) THEN
            ALTER TABLE worktrees ADD COLUMN is_pinned BOOLEAN DEFAULT FALSE;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] is_pinned column added to worktrees');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add is_pinned column to worktrees:', error);
      throw error;
    }

    // Add is_archived column to worktrees (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'worktrees' AND column_name = 'is_archived'
          ) THEN
            ALTER TABLE worktrees ADD COLUMN is_archived BOOLEAN DEFAULT FALSE;
            CREATE INDEX IF NOT EXISTS idx_worktrees_archived ON worktrees(is_archived);
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] is_archived column added to worktrees');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add is_archived column to worktrees:', error);
      throw error;
    }

    // Add parent_session_id column to ai_sessions for hierarchical sessions (migration)
    // This enables workstreams (grouped sessions) and hierarchical worktree sessions
    // - parent_session_id = NULL means root level session (shows in left panel)
    // - parent_session_id != NULL means child session (shows as tab within parent)
    // - Children inherit worktree_id from parent
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          -- Add parent_session_id for hierarchical workstream structure
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'parent_session_id'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN parent_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL;
          END IF;
        END $$;
      `);

      // Create index for efficient child session queries
      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_parent ON ai_sessions(parent_session_id);
      `);

      console.log('[PGLite Worker] parent_session_id column added to ai_sessions');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add parent_session_id column:', error);
      throw error;
    }

    // Add meta-agent session tracking columns to ai_sessions (migration)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'agent_role'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN agent_role TEXT DEFAULT 'standard';
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'created_by_session_id'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN created_by_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL;
          END IF;
        END $$;
      `);

      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_agent_role ON ai_sessions(agent_role);
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_created_by ON ai_sessions(created_by_session_id);
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_created_by_workspace ON ai_sessions(created_by_session_id, workspace_id) WHERE created_by_session_id IS NOT NULL;
      `);

    } catch (error) {
      console.error('[PGLite Worker] Failed to add meta-agent session columns:', error);
      throw error;
    }

    // Add branch tracking columns to ai_sessions (migration)
    // branched_from_session_id is SEPARATE from parent_session_id:
    // - parent_session_id = hierarchical containment (workstreams, child tabs)
    // - branched_from_session_id = session forking (branch off at a message to try different approach)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          -- Add branched_from_session_id to track which session this was forked from
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'branched_from_session_id'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN branched_from_session_id TEXT REFERENCES ai_sessions(id) ON DELETE SET NULL;
          END IF;

          -- Add branch_point_message_id to track at which message the branch occurred
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'branch_point_message_id'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN branch_point_message_id BIGINT;
          END IF;

          -- Add branched_at timestamp to track when the branch was created
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'branched_at'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN branched_at TIMESTAMPTZ;
          END IF;
        END $$;
      `);

      // Create index for branch queries
      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_ai_sessions_branched_from ON ai_sessions(branched_from_session_id);
      `);

      console.log('[PGLite Worker] Branch tracking columns added to ai_sessions');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add branch tracking columns:', error);
      throw error;
    }

    // Migration: Move any existing branch data that was incorrectly stored in parent_session_id
    // If a session has branch_point_message_id set, it's a branch (not a workstream child)
    // Move that reference to branched_from_session_id
    try {
      await this.db.exec(`
        UPDATE ai_sessions
        SET branched_from_session_id = parent_session_id,
            parent_session_id = NULL
        WHERE branch_point_message_id IS NOT NULL
          AND parent_session_id IS NOT NULL
          AND branched_from_session_id IS NULL;
      `);
      console.log('[PGLite Worker] Migrated branch data to branched_from_session_id');
    } catch (error) {
      console.error('[PGLite Worker] Failed to migrate branch data:', error);
      // Non-fatal - continue even if migration fails (might be no data to migrate)
    }

    // Migration: Convert ai_sessions timestamp columns from TIMESTAMP to TIMESTAMPTZ
    // PGLite misinterprets Date objects for TIMESTAMP (without timezone) columns,
    // adding the local timezone offset. TIMESTAMPTZ handles Date objects correctly.
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          -- Check if created_at is still TIMESTAMP (without timezone)
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions'
              AND column_name = 'created_at'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE ai_sessions ALTER COLUMN created_at TYPE TIMESTAMPTZ;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions'
              AND column_name = 'updated_at'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE ai_sessions ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions'
              AND column_name = 'last_read_timestamp'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE ai_sessions ALTER COLUMN last_read_timestamp TYPE TIMESTAMPTZ;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions'
              AND column_name = 'branched_at'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE ai_sessions ALTER COLUMN branched_at TYPE TIMESTAMPTZ;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] Migrated ai_sessions timestamp columns to TIMESTAMPTZ');
    } catch (error) {
      console.error('[PGLite Worker] Failed to migrate timestamp columns:', error);
      // Non-fatal for existing installs
    }

    // Migration: Convert any remaining TIMESTAMP (without timezone) columns to TIMESTAMPTZ
    // Ensures all legacy tables follow the TIMESTAMPTZ-only rule.
    // NOTE: We intentionally rely on the default cast (no AT TIME ZONE 'UTC').
    // Legacy TIMESTAMP values were written via JS Date objects and thus represent
    // local wall time already; forcing UTC would double-shift existing data.
    try {
      const legacyTimestamps = await this.db.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type = 'timestamp without time zone'
      `);

      const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;

      for (const row of legacyTimestamps.rows) {
        const tableName = quoteIdent(row.table_name);
        const columnName = quoteIdent(row.column_name);
        await this.db.exec(`ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE TIMESTAMPTZ;`);
      }

      if (legacyTimestamps.rows.length > 0) {
        console.log(
          `[PGLite Worker] Migrated ${legacyTimestamps.rows.length} timestamp columns to TIMESTAMPTZ`
        );
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to migrate legacy timestamp columns:', error);
      // Non-fatal for existing installs
    }

    // Migration: Rename ralph_loops -> super_loops and ralph_iterations -> super_iterations
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ralph_loops')
             AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'super_loops') THEN
            ALTER TABLE ralph_loops RENAME TO super_loops;
            ALTER INDEX IF EXISTS idx_ralph_loops_worktree RENAME TO idx_super_loops_worktree;
            ALTER INDEX IF EXISTS idx_ralph_loops_status RENAME TO idx_super_loops_status;
          END IF;

          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ralph_iterations')
             AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'super_iterations') THEN
            ALTER TABLE ralph_iterations RENAME TO super_iterations;
            ALTER TABLE super_iterations RENAME COLUMN ralph_loop_id TO super_loop_id;
            ALTER INDEX IF EXISTS idx_ralph_iterations_loop RENAME TO idx_super_iterations_loop;
            ALTER INDEX IF EXISTS idx_ralph_iterations_session RENAME TO idx_super_iterations_session;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] Migrated ralph_loops/ralph_iterations -> super_loops/super_iterations');
    } catch (error) {
      console.error('[PGLite Worker] Failed to migrate ralph -> super loop tables:', error);
      // Non-fatal - tables may not exist yet
    }

    // Super Loops table - autonomous AI agent loop pattern
    // Super Loops run iteratively until a task is complete, with fresh context each iteration
    console.log('[PGLite Worker] Creating super_loops table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS super_loops (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          task_description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          current_iteration INTEGER DEFAULT 0,
          max_iterations INTEGER DEFAULT 20,
          completion_reason TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_super_loops_worktree ON super_loops(worktree_id);
        CREATE INDEX IF NOT EXISTS idx_super_loops_status ON super_loops(status);
      `);
      console.log('[PGLite Worker] super_loops table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create super_loops table:', error);
      throw error;
    }

    // Super Iterations table - each iteration is linked to an AI session
    console.log('[PGLite Worker] Creating super_iterations table...');
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS super_iterations (
          id TEXT PRIMARY KEY,
          super_loop_id TEXT NOT NULL REFERENCES super_loops(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
          iteration_number INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          exit_reason TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          completed_at TIMESTAMPTZ
        );

        CREATE INDEX IF NOT EXISTS idx_super_iterations_loop ON super_iterations(super_loop_id);
        CREATE INDEX IF NOT EXISTS idx_super_iterations_session ON super_iterations(session_id);
      `);
      console.log('[PGLite Worker] super_iterations table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create super_iterations table:', error);
      throw error;
    }

    // Add model_id column to super_loops (for per-loop model selection)
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'super_loops' AND column_name = 'model_id'
          ) THEN
            ALTER TABLE super_loops ADD COLUMN model_id TEXT;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] model_id column added to super_loops');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add model_id column to super_loops:', error);
      throw error;
    }

    // Add title, is_archived, is_pinned columns to super_loops
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'super_loops' AND column_name = 'title'
          ) THEN
            ALTER TABLE super_loops ADD COLUMN title TEXT;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'super_loops' AND column_name = 'is_archived'
          ) THEN
            ALTER TABLE super_loops ADD COLUMN is_archived BOOLEAN DEFAULT FALSE;
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'super_loops' AND column_name = 'is_pinned'
          ) THEN
            ALTER TABLE super_loops ADD COLUMN is_pinned BOOLEAN DEFAULT FALSE;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] title, is_archived, is_pinned columns added to super_loops');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add title/is_archived/is_pinned columns to super_loops:', error);
      throw error;
    }

    // Migration: Repurpose session_type from interaction mode (chat/coding/terminal/planning)
    // to structural type (session/workstream/worktree/blitz).
    // The old values were redundant with provider + mode columns.
    // New values describe what the session IS in the hierarchy.
    try {
      await this.db.exec(`
        -- Step 1: Mark workstream parents (sessions that have children pointing to them)
        -- but only if they aren't already 'blitz' or 'voice'
        UPDATE ai_sessions
        SET session_type = 'workstream'
        WHERE session_type NOT IN ('blitz', 'voice')
          AND id IN (SELECT DISTINCT parent_session_id FROM ai_sessions WHERE parent_session_id IS NOT NULL);

        -- Step 2: Everything else that isn't blitz, workstream, or voice becomes 'session'
        UPDATE ai_sessions
        SET session_type = 'session'
        WHERE session_type NOT IN ('blitz', 'workstream', 'voice');
      `);
      console.log('[PGLite Worker] Migrated session_type to structural types (session/workstream/blitz)');
    } catch (error) {
      console.error('[PGLite Worker] Failed to migrate session_type:', error);
      // Non-fatal - old values still work, just not meaningful
    }

    // Migration: Drop voice_sessions table if it exists (voice sessions now use ai_sessions)
    try {
      await this.db.exec(`DROP TABLE IF EXISTS voice_sessions;`);
    } catch (error) {
      // Non-fatal
    }

    // Remove accidental worktree workstreams: a worktree IS the workstream — the
    // `worktrees` row is the container, and every session inside it is a flat
    // sibling keyed by worktree_id. Older /launch-new-session and convert-to-
    // workstream paths incorrectly created `session_type='workstream'` rows
    // either inside a worktree (worktree_id set on the workstream) or as a
    // hidden parent of worktree-resident children. These containers carry no
    // user content (no messages of their own) — they exist only as a side
    // effect of the bug — so we delete them outright rather than try to
    // preserve them as flat sessions. The FK on parent_session_id is
    // ON DELETE SET NULL, so children get auto-unparented (their worktree_id
    // is unchanged), and the renderer's worktreeGroupsData re-groups them
    // flat under the worktree.
    //
    // Safety guard: skip any workstream that somehow has its own messages.
    // The bug should never have created one with messages, but a per-row
    // check costs almost nothing and prevents accidental content loss on
    // a stranger's database.
    try {
      await this.db.exec(`
        DELETE FROM ai_sessions
        WHERE session_type = 'workstream'
          AND NOT EXISTS (
            SELECT 1 FROM ai_agent_messages m WHERE m.session_id = ai_sessions.id
          )
          AND (
            worktree_id IS NOT NULL
            OR id IN (
              SELECT DISTINCT parent_session_id
              FROM ai_sessions
              WHERE parent_session_id IS NOT NULL
                AND worktree_id IS NOT NULL
            )
          );
      `);
      console.log('[PGLite Worker] Deleted accidental worktree workstreams (children auto-unparented via FK SET NULL)');
    } catch (error) {
      console.error('[PGLite Worker] Failed to delete worktree workstreams:', error);
      // Non-fatal - bug only affects left-pane grouping, not data integrity
    }

    // Migration: Add file_timestamp column to ai_tool_call_file_edits
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_tool_call_file_edits' AND column_name = 'file_timestamp'
          ) THEN
            ALTER TABLE ai_tool_call_file_edits ADD COLUMN file_timestamp TIMESTAMPTZ;
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] file_timestamp column added to ai_tool_call_file_edits');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add file_timestamp column:', error);
      throw error;
    }

    // Migration: Add composite index on ai_agent_messages for tool call matching query pattern
    try {
      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_messages_direction_hidden ON ai_agent_messages(session_id, direction, hidden, id);
      `);
    } catch (error) {
      console.error('[PGLite Worker] Failed to create direction/hidden index:', error);
      // Non-fatal
    }

    // Migration: Create ai_transcript_events table for canonical transcript storage
    // This is the product-facing canonical layer; ai_agent_messages remains the raw source log.
    const { TRANSCRIPT_EVENTS_CREATE_TABLE, TRANSCRIPT_EVENTS_INDEXES } = require('./schemas/transcriptEvents');
    try {
      await this.db.exec(TRANSCRIPT_EVENTS_CREATE_TABLE);
      // PGLite requires one statement per exec for indexes
      for (const indexStmt of TRANSCRIPT_EVENTS_INDEXES) {
        await this.db.exec(indexStmt);
      }
      console.log('[PGLite Worker] ai_transcript_events table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create ai_transcript_events table:', error);
      // Non-fatal - transcript features will be unavailable but app continues
    }

    // Migration: Add canonical transform projection columns to ai_sessions
    try {
      await this.db.exec(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'canonical_transform_version'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN canonical_transform_version INTEGER;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'canonical_last_raw_message_id'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN canonical_last_raw_message_id BIGINT;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'canonical_last_transformed_at'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN canonical_last_transformed_at TIMESTAMPTZ;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ai_sessions' AND column_name = 'canonical_transform_status'
          ) THEN
            ALTER TABLE ai_sessions ADD COLUMN canonical_transform_status TEXT
              CHECK (canonical_transform_status IN ('pending', 'complete', 'error'));
          END IF;
        END $$;
      `);
      console.log('[PGLite Worker] canonical transform columns added to ai_sessions');
    } catch (error) {
      console.error('[PGLite Worker] Failed to add canonical transform columns:', error);
      // Non-fatal - lazy transformation will be unavailable but app continues
    }

    // Migration: local-only shared-document origin bindings for re-upload.
    try {
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS collab_local_origins (
          org_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          git_remote_hash TEXT,
          workspace_path_hash TEXT,
          relative_path TEXT NOT NULL,
          document_type TEXT NOT NULL,
          source_basename TEXT NOT NULL,
          last_local_content_hash TEXT,
          last_collab_content_hash TEXT,
          last_synced_at TIMESTAMPTZ,
          last_seen_mtime_ms BIGINT,
          last_seen_size_bytes BIGINT,
          resolution_status TEXT NOT NULL DEFAULT 'resolved'
            CHECK (resolution_status IN ('resolved', 'missing', 'relinked', 'conflict')),
          resolution_error TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (org_id, document_id)
        );
      `);
      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_collab_local_origins_git_remote_hash
          ON collab_local_origins (git_remote_hash);
      `);
      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_collab_local_origins_relative_path
          ON collab_local_origins (org_id, relative_path);
      `);
      console.log('[PGLite Worker] collab_local_origins table created successfully');
    } catch (error) {
      console.error('[PGLite Worker] Failed to create collab_local_origins table:', error);
      throw error;
    }

    // Migration: Ensure ai_tool_call_file_edits FK points to ai_agent_messages (not ai_transcript_events).
    // A previous buggy migration may have re-pointed it to ai_transcript_events.
    try {
      const fkCheck = await this.db.query(`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'ai_tool_call_file_edits'::regclass
          AND conname = 'fk_atcfe_message'
          AND confrelid = 'ai_transcript_events'::regclass
      `);
      if (fkCheck.rows.length > 0) {
        await this.db.exec(`TRUNCATE ai_tool_call_file_edits`);
        await this.db.exec(`ALTER TABLE ai_tool_call_file_edits DROP CONSTRAINT fk_atcfe_message`);
        await this.db.exec(`
          ALTER TABLE ai_tool_call_file_edits
            ADD CONSTRAINT fk_atcfe_message
            FOREIGN KEY (message_id) REFERENCES ai_agent_messages(id) ON DELETE CASCADE
        `);
        console.log('[PGLite Worker] Fixed ai_tool_call_file_edits FK: restored reference to ai_agent_messages');
      }
    } catch (error) {
      console.error('[PGLite Worker] Failed to fix ai_tool_call_file_edits FK:', error);
    }
  }

  async query(message) {
    if (!this.db) throw new Error('Database not initialized');

    this.activeOps++;
    try {
      const execStart = performance.now();
      const result = await this.db.query(message.payload.sql, message.payload.params);
      const execMs = performance.now() - execStart;
      return {
        id: message.id,
        success: true,
        data: result,
        execMs
      };
    } finally {
      this.activeOps--;
    }
  }

  async exec(message) {
    if (!this.db) throw new Error('Database not initialized');

    this.activeOps++;
    try {
      const execStart = performance.now();
      await this.db.exec(message.payload.sql);
      const execMs = performance.now() - execStart;
      return {
        id: message.id,
        success: true,
        execMs
      };
    } finally {
      this.activeOps--;
    }
  }

  // Run a user-supplied SELECT inside a READ ONLY transaction with a bounded
  // statement_timeout. Used by the extension `host.data.query` API so panel
  // extensions can read the local PGLite store without being able to mutate it.
  //
  // The whole BEGIN/SET LOCAL/SELECT/COMMIT runs atomically inside PGLite's
  // native db.transaction() so concurrent callers cannot interleave between
  // the SET and the SELECT.
  async queryReadOnly(message) {
    if (!this.db) throw new Error('Database not initialized');

    const sql = message.payload?.sql;
    const params = message.payload?.params;
    const rawTimeout = Number(message.payload?.timeoutMs);
    const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.floor(rawTimeout), 30000)
      : 5000;

    if (typeof sql !== 'string' || sql.length === 0) {
      throw new Error('queryReadOnly: sql must be a non-empty string');
    }

    this.activeOps++;
    try {
      const execStart = performance.now();
      const result = await this.db.transaction(async (tx) => {
        await tx.exec('SET TRANSACTION READ ONLY');
        // SET LOCAL reverts at COMMIT so this doesn't leak to the next caller
        // on the same PGLite session.
        await tx.exec(`SET LOCAL statement_timeout = '${timeoutMs}'`);
        return await tx.query(sql, params);
      });
      const execMs = performance.now() - execStart;
      return {
        id: message.id,
        success: true,
        data: result,
        execMs
      };
    } finally {
      this.activeOps--;
    }
  }

  async close(message) {
    if (this.walMaintenanceInterval) {
      clearInterval(this.walMaintenanceInterval);
      this.walMaintenanceInterval = null;
    }
    if (this.db) {
      console.log('[PGLite Worker] Closing database...');
      try {
        // Force a CHECKPOINT before close.
        // Why: --single mode has no background checkpointer, so WAL only shrinks via
        // explicit CHECKPOINT or the smart-shutdown sequence. If the caller's close
        // budget (2-5s) gets preempted by force-quit before smart-shutdown's internal
        // checkpoint runs, WAL stays large and the next launch is slow. Doing it
        // explicitly here makes the cleanup happen even if the subsequent db.close()
        // is killed mid-flight. Non-fatal on failure.
        try {
          const ckptStart = performance.now();
          await this.db.exec('CHECKPOINT');
          console.log(`[PGLite Worker] Pre-close CHECKPOINT took ${(performance.now() - ckptStart).toFixed(0)}ms`);
        } catch (ckptError) {
          console.warn('[PGLite Worker] Pre-close CHECKPOINT failed (non-fatal):', ckptError?.message || ckptError);
        }

        // Close the database connection
        await this.db.close();
        console.log('[PGLite Worker] Database closed successfully');

        // Release our application-level lock
        this.releaseLock();

        // Also clean up PGLite's internal postmaster.pid if present
        const fs = require('fs');
        const postmasterPidPath = path.join(this.dataDir, 'postmaster.pid');
        try {
          if (fs.existsSync(postmasterPidPath)) {
            fs.unlinkSync(postmasterPidPath);
            console.log('[PGLite Worker] Removed PGLite postmaster.pid after close');
          }
        } catch (lockError) {
          console.warn('[PGLite Worker] Failed to remove postmaster.pid after close:', lockError);
        }

        this.db = null;
      } catch (error) {
        console.error('[PGLite Worker] Error during database close:', error);
        this.db = null;
        throw error;
      }
    }
    return {
      id: message.id,
      success: true
    };
  }

  async getStats(message) {
    if (!this.db) throw new Error('Database not initialized');

    const result = await this.db.query(`
      SELECT
        (SELECT COUNT(*) FROM ai_sessions) as ai_sessions_count,
        (SELECT COUNT(*) FROM document_history) as history_count,
        pg_database_size(current_database()) as database_size
    `);

    return {
      id: message.id,
      success: true,
      data: result.rows[0]
    };
  }

  async verifyBackup(message) {
    const backupPath = message.payload.backupPath;
    let testDb = null;

    try {
      console.log('[PGLite Worker] Verifying backup at:', backupPath);

      // Attempt to open the backup database
      testDb = new PGlite({
        dataDir: backupPath,
        debug: 0
      });

      await testDb.waitReady;

      // Execute a simple query to verify it works
      await testDb.query('SELECT 1');

      // Check data counts in key tables for integrity verification
      let sessionCount = 0;
      let historyCount = 0;
      try {
        const countResult = await testDb.query(`
          SELECT
            (SELECT COUNT(*) FROM ai_sessions) as sessions,
            (SELECT COUNT(*) FROM document_history) as history
        `);
        if (countResult.rows && countResult.rows[0]) {
          sessionCount = parseInt(countResult.rows[0].sessions) || 0;
          historyCount = parseInt(countResult.rows[0].history) || 0;
        }
      } catch (countError) {
        // Tables might not exist yet - that's okay for a fresh database
        console.log('[PGLite Worker] Could not count records (tables may not exist):', countError.message);
      }

      // Close cleanly
      await testDb.close();

      console.log('[PGLite Worker] Backup verification successful', {
        sessionCount,
        historyCount
      });

      return {
        id: message.id,
        success: true,
        data: {
          valid: true,
          sessionCount,
          historyCount,
          hasData: sessionCount > 0 || historyCount > 0
        }
      };
    } catch (error) {
      console.error('[PGLite Worker] Backup verification failed:', error);

      if (testDb) {
        try {
          await testDb.close();
        } catch (closeError) {
          // Ignore close errors
        }
      }

      return {
        id: message.id,
        success: true,
        data: { valid: false, error: error.message || String(error) }
      };
    }
  }
}

// Start the worker
new PGLiteWorker();
