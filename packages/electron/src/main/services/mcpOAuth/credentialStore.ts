/**
 * Nimbalyst-only storage for remote MCP OAuth credentials.
 *
 * One file per binding key under `<userData>/mcp-oauth/`:
 *   - `<key>.enc`   record encrypted with Electron `safeStorage`
 *   - `<key>.json`  plaintext record, mode 0600, only when `safeStorage` has no
 *                   backend (Linux without a keyring). Same protection the old
 *                   `~/.mcp-auth` store gave, but not shared with other apps.
 *   - `<key>.tombstone.json`  revoke marker, no secrets
 *   - `<key>.revoked-<ms>.(enc|json)`  revoked record, kept 7 days, never loaded
 *
 * What this does and does not protect: the records are kept out of every
 * config, argv, env and protocol response Nimbalyst produces. At rest they are
 * only as private as the platform makes a same-user file. On Windows (DPAPI)
 * and Linux, another process running as the same user can decrypt them.
 *
 * Writes are atomic (temp file + rename) and keep the previous version as
 * `<file>.bak`. Every write is compare-and-set on the record's `generation`,
 * serialized per key, so a refresh that finishes after a revoke or a new
 * sign-in cannot resurrect the old credentials.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { McpOAuthBinding, McpOAuthTombstone } from './types';

export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type LoadResult =
  | { status: 'present'; binding: McpOAuthBinding }
  | { status: 'absent' }
  | { status: 'unreadable' };

const REVOKED_BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[a-f0-9]{16,64}$/;

export class McpOAuthCredentialStore {
  private readonly cache = new Map<string, LoadResult>();
  private readonly tombstones = new Map<string, McpOAuthTombstone | null>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Keys whose `.enc` could not be decrypted on the last read. */
  private readonly undecryptable = new Set<string>();
  private dirReady = false;

  constructor(
    private readonly dir: string,
    private readonly codec: SecretCodec,
  ) {}

  getDirectory(): string {
    return this.dir;
  }

  async load(key: string): Promise<LoadResult> {
    assertKey(key);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const result = await this.readFromDisk(key);
    // An unreadable record is not cached: a keyring that unlocks later is
    // picked up at the next read.
    if (result.status !== 'unreadable') {
      this.cache.set(key, result);
    }
    return result;
  }

  /** False when a record exists that this session can neither read nor replace. */
  canWrite(key: string): boolean {
    assertKey(key);
    return this.codec.isEncryptionAvailable() || !fs.existsSync(this.recordPath(key, 'enc'));
  }

  async loadTombstone(key: string): Promise<McpOAuthTombstone | null> {
    assertKey(key);
    if (this.tombstones.has(key)) {
      return this.tombstones.get(key) ?? null;
    }
    let tombstone: McpOAuthTombstone | null = null;
    try {
      const raw = await fs.promises.readFile(this.tombstonePath(key), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.bindingKey === key) {
        tombstone = {
          version: 1,
          bindingKey: key,
          revokedAt: String(parsed.revokedAt ?? ''),
          generation: Number(parsed.generation) || 0,
          importFingerprints: Array.isArray(parsed.importFingerprints)
            ? parsed.importFingerprints.filter((v: unknown): v is string => typeof v === 'string')
            : [],
        };
      }
    } catch {
      tombstone = null;
    }
    this.tombstones.set(key, tombstone);
    return tombstone;
  }

  /** The generation a new write must be based on. */
  async currentGeneration(key: string): Promise<number> {
    const loaded = await this.load(key);
    const tombstone = await this.loadTombstone(key);
    const bindingGeneration = loaded.status === 'present' ? loaded.binding.generation : 0;
    return Math.max(bindingGeneration, tombstone?.generation ?? 0);
  }

  /**
   * Write `binding` only if the stored generation still equals
   * `expectedGeneration` and `precondition`, evaluated inside the same
   * serialized step, accepts the stored record. Returns false, writing
   * nothing, otherwise. The precondition covers changes that do not bump the
   * generation (a refresh rotating tokens) and state outside the store.
   */
  async saveIfGeneration(
    binding: McpOAuthBinding,
    expectedGeneration: number,
    precondition?: (current: McpOAuthBinding | null) => boolean,
  ): Promise<boolean> {
    const key = binding.bindingKey;
    assertKey(key);
    return this.serialize(key, async () => {
      const current = await this.currentGeneration(key);
      if (current !== expectedGeneration) {
        return false;
      }
      if (precondition) {
        const loaded = await this.load(key);
        if (!precondition(loaded.status === 'present' ? loaded.binding : null)) {
          return false;
        }
      }
      // Cached first: if the disk write fails, this run still uses what was
      // just obtained (a rotated refresh token would otherwise be lost).
      this.cache.set(key, { status: 'present', binding });
      await this.writeRecord(binding);
      // A tombstone at a lower generation stays on disk: its import
      // fingerprints still block re-importing the revoked legacy tokens.
      return true;
    });
  }

  /**
   * Revoke locally: write the tombstone at a higher generation first, then
   * move the secret-bearing record to a dated backup. Returns the record that
   * was revoked, so the caller can ask the provider to revoke its tokens.
   */
  async revoke(key: string, extraFingerprints: string[] = []): Promise<McpOAuthBinding | null> {
    assertKey(key);
    return this.serialize(key, async () => {
      const loaded = await this.load(key);
      const previous = await this.loadTombstone(key);
      const binding = loaded.status === 'present' ? loaded.binding : null;
      const generation = (await this.currentGeneration(key)) + 1;
      const fingerprints = new Set(previous?.importFingerprints ?? []);
      if (binding?.importFingerprint) {
        fingerprints.add(binding.importFingerprint);
      }
      for (const fingerprint of extraFingerprints) {
        fingerprints.add(fingerprint);
      }
      const tombstone: McpOAuthTombstone = {
        version: 1,
        bindingKey: key,
        revokedAt: new Date().toISOString(),
        generation,
        importFingerprints: Array.from(fingerprints),
      };
      await this.ensureDir();
      await writeAtomic(this.tombstonePath(key), JSON.stringify(tombstone), false);
      this.tombstones.set(key, tombstone);
      this.cache.set(key, { status: 'absent' });

      for (const ext of ['enc', 'json'] as const) {
        const file = this.recordPath(key, ext);
        if (fs.existsSync(file)) {
          const backup = path.join(this.dir, `${key}.revoked-${Date.now()}.${ext}`);
          await fs.promises.rename(file, backup);
          await removeIfExists(`${file}.bak`);
        }
      }
      return binding;
    });
  }

  /** Remove revoked-record backups older than the retention window. */
  async pruneRevokedBackups(now = Date.now()): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const match = /^[a-f0-9]+\.revoked-(\d+)\.(enc|json)$/.exec(name);
      if (match && now - Number(match[1]) > REVOKED_BACKUP_RETENTION_MS) {
        await removeIfExists(path.join(this.dir, name));
      }
    }
  }

  /** Forget cached reads. Tests and the revoke path use it after external changes. */
  invalidate(key?: string): void {
    if (key) {
      this.cache.delete(key);
      this.tombstones.delete(key);
    } else {
      this.cache.clear();
      this.tombstones.clear();
    }
  }

  private async readFromDisk(key: string): Promise<LoadResult> {
    const encPath = this.recordPath(key, 'enc');
    const jsonPath = this.recordPath(key, 'json');
    if (fs.existsSync(encPath)) {
      if (!this.codec.isEncryptionAvailable()) {
        return { status: 'unreadable' };
      }
      try {
        const buffer = await fs.promises.readFile(encPath);
        const parsed = parseRecord(this.codec.decryptString(buffer), key);
        this.undecryptable.delete(key);
        return parsed;
      } catch {
        this.undecryptable.add(key);
        return { status: 'unreadable' };
      }
    }
    if (fs.existsSync(jsonPath)) {
      try {
        return parseRecord(await fs.promises.readFile(jsonPath, 'utf8'), key);
      } catch {
        return { status: 'unreadable' };
      }
    }
    return { status: 'absent' };
  }

  private async writeRecord(binding: McpOAuthBinding): Promise<void> {
    await this.ensureDir();
    const key = binding.bindingKey;
    const json = JSON.stringify(binding);
    if (this.codec.isEncryptionAvailable()) {
      const target = this.recordPath(key, 'enc');
      if (this.undecryptable.has(key) && fs.existsSync(target)) {
        // Never overwrite a record that could not be decrypted (a reset
        // keychain, another machine's copy): keep it aside, recoverable.
        await fs.promises.rename(target, path.join(this.dir, `${key}.unreadable-${Date.now()}.enc`));
        this.undecryptable.delete(key);
      }
      await writeAtomic(target, this.codec.encryptString(json), true);
      // A plaintext record from a keyring-less session is superseded.
      await removeIfExists(this.recordPath(key, 'json'));
      await removeIfExists(`${this.recordPath(key, 'json')}.bak`);
      return;
    }
    const encPath = this.recordPath(key, 'enc');
    if (fs.existsSync(encPath)) {
      // Never replace a record we cannot read with a plaintext one; the user
      // may get the keyring back.
      throw new Error('An encrypted credential exists but encryption is unavailable.');
    }
    await writeAtomic(this.recordPath(key, 'json'), json, true);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) {
      return;
    }
    await fs.promises.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await fs.promises.chmod(this.dir, 0o700);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    this.dirReady = true;
  }

  private recordPath(key: string, ext: 'enc' | 'json'): string {
    return path.join(this.dir, `${key}.${ext}`);
  }

  private tombstonePath(key: string): string {
    return path.join(this.dir, `${key}.tombstone.json`);
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }
}

function parseRecord(raw: string, key: string): LoadResult {
  const parsed = JSON.parse(raw);
  if (
    !parsed
    || parsed.version !== 1
    || parsed.bindingKey !== key
    || typeof parsed.issuer !== 'string'
    || typeof parsed.serverUrl !== 'string'
    || !parsed.asMetadata
    || typeof parsed.asMetadata.token_endpoint !== 'string'
    || !parsed.client
    || typeof parsed.client.client_id !== 'string'
  ) {
    return { status: 'unreadable' };
  }
  return { status: 'present', binding: parsed as McpOAuthBinding };
}

async function writeAtomic(target: string, data: string | Buffer, keepBackup: boolean): Promise<void> {
  const temp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  const handle = await fs.promises.open(temp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (keepBackup && fs.existsSync(target)) {
    await fs.promises.copyFile(target, `${target}.bak`);
    try {
      await fs.promises.chmod(`${target}.bak`, 0o600);
    } catch {
      // Best effort.
    }
  }
  await fs.promises.rename(temp, target);
}

async function removeIfExists(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch {
    // Missing is fine.
  }
}

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error('Invalid credential key');
  }
}
