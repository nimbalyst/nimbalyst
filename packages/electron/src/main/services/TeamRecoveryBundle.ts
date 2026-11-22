import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';

/** Original source rows stay in the encrypted artifact even when a normalized import is derived. */
export interface TeamRecoveryBundle {
  version: 1;
  orgId: string;
  createdAt: string;
  projects: Record<string, unknown>[];
  trackerRows: Record<string, unknown>[];
  documents: Record<string, unknown>[];
}

const FORMAT = 'nimbalyst-team-recovery';
// Version 2 stores each distinct byte payload once. Version 1 wrote every copy
// and existed only in unreleased builds, so it is refused rather than migrated.
const FORMAT_VERSION = 2;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_DEPTH = 1000;
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;
const EXISTS_MESSAGE = 'A file with that name already exists. Recovery never overwrites a saved bundle; choose a new name.';

/**
 * The same attachment or document bytes reach a bundle from several sources:
 * the local replica, the local attachment cache, the prepared payload, and
 * contributions imported from another device. Every string under these keys
 * is stored once by content hash and referenced as `blob:<sha256>`. All such
 * strings are replaced, whatever their content, so the mapping is exact.
 */
const BLOB_FIELDS = new Set(['base64', 'snapshot']);
const BLOB_REF = /^blob:([a-f0-9]{64})$/;

function invalidFormat(): Error { return new Error('Invalid recovery bundle format'); }

function limitError(bytes: number): Error {
  return new Error(`This recovery needs about ${Math.ceil(bytes / (1024 * 1024))} MiB, above the 128 MiB limit for one encrypted recovery bundle`);
}

/** Map an exclusive-create failure to a message that says why nothing was replaced. */
export function exclusiveCreateError(error: unknown, message = EXISTS_MESSAGE): Error {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') return new Error(message);
  return error instanceof Error ? error : new Error(String(error));
}

function dehydrate(bundle: TeamRecoveryBundle, nameFor: (value: string, index: number) => string): { skeleton: unknown; blobs: Map<string, string> } {
  const names = new Map<string, string>();
  const blobs = new Map<string, string>();
  const reference = (value: string) => {
    let name = names.get(value);
    if (!name) { name = nameFor(value, names.size); names.set(value, name); blobs.set(name, value); }
    return `blob:${name}`;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) throw invalidFormat();
    if (Array.isArray(value)) return value.map(entry => visit(entry, depth + 1));
    // Leave Date-like values to JSON.stringify, as the single-copy format did.
    if (!value || typeof value !== 'object' || typeof (value as { toJSON?: unknown }).toJSON === 'function') return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = typeof entry === 'string' && BLOB_FIELDS.has(key) ? reference(entry) : visit(entry, depth + 1);
    }
    return out;
  };
  return { skeleton: visit(bundle, 0), blobs };
}

function estimate(skeleton: unknown, blobs: Map<string, string>): number {
  let bytes = Buffer.byteLength(JSON.stringify(skeleton)) + 32;
  for (const [name, value] of blobs) bytes += name.length + Buffer.byteLength(value) + 6;
  return bytes;
}

/**
 * Size check without hashing or serializing payloads, so an oversized
 * recovery fails before a file is chosen or the passphrase is stretched.
 */
export function assertRecoveryBundleFits(bundle: TeamRecoveryBundle): void {
  const { skeleton, blobs } = dehydrate(bundle, (_value, index) => index.toString(16).padStart(64, '0'));
  const bytes = estimate(skeleton, blobs);
  if (bytes > MAX_BYTES) throw limitError(bytes);
}

function hydrate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidFormat();
  const { bundle, blobs } = value as { bundle?: unknown; blobs?: unknown };
  if (!blobs || typeof blobs !== 'object' || Array.isArray(blobs)) throw invalidFormat();
  const table = blobs as Record<string, unknown>;
  // In place: the parsed blob strings are referenced, never copied again.
  const visit = (entry: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) throw invalidFormat();
    if (Array.isArray(entry)) { for (let index = 0; index < entry.length; index++) entry[index] = visit(entry[index], depth + 1); return entry; }
    if (!entry || typeof entry !== 'object') return entry;
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      const field = row[key];
      if (typeof field === 'string' && BLOB_FIELDS.has(key)) {
        const name = BLOB_REF.exec(field)?.[1];
        const blob = name && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
        if (typeof blob !== 'string') throw invalidFormat();
        row[key] = blob;
      } else row[key] = visit(field, depth + 1);
    }
    return row;
  };
  return visit(bundle, 0);
}

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 16 || password.length > 1024) {
    throw new Error('Use a recovery passphrase of 16 to 1024 characters');
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  validatePassword(password);
  // The work factor is fixed by this version, never taken from an untrusted bundle.
  return new Promise((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}

function aad(orgId: string): Buffer {
  return Buffer.from(JSON.stringify([FORMAT, FORMAT_VERSION, orgId]));
}

function validateBundle(value: unknown, orgId: string): TeamRecoveryBundle {
  if (!value || typeof value !== 'object') throw new Error('Invalid recovery bundle format');
  const data = value as TeamRecoveryBundle;
  if (data.version !== 1 || data.orgId !== orgId || !orgId || orgId.length > 256
    || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) {
    throw new Error('Invalid recovery bundle format or organization');
  }
  for (const rows of [data.projects, data.trackerRows, data.documents]) {
    if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Invalid recovery bundle format');
    }
  }
  return data;
}

/** `digest` covers the exact plaintext, so a readback can be compared without a second serialized copy. */
async function seal(bundle: TeamRecoveryBundle, password: string): Promise<{ serialized: string; digest: string }> {
  validateBundle(bundle, bundle.orgId);
  validatePassword(password);
  const { skeleton, blobs } = dehydrate(bundle, value => createHash('sha256').update(value).digest('hex'));
  const expected = estimate(skeleton, blobs);
  if (expected > MAX_BYTES) throw limitError(expected);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(bundle.orgId));
    const digest = createHash('sha256');
    const chunks: Buffer[] = [];
    let total = 0;
    // Encrypt piece by piece rather than building one plaintext buffer of the whole bundle.
    const write = (text: string) => {
      const bytes = Buffer.from(text, 'utf8');
      try {
        total += bytes.byteLength;
        if (total > MAX_BYTES) throw limitError(total);
        digest.update(bytes);
        chunks.push(cipher.update(bytes));
      } finally { bytes.fill(0); }
    };
    write('{"bundle":');
    write(JSON.stringify(skeleton));
    write(',"blobs":{');
    let first = true;
    for (const [name, value] of blobs) {
      write(`${first ? '' : ','}${JSON.stringify(name)}:`);
      write(JSON.stringify(value));
      first = false;
    }
    write('}}');
    chunks.push(cipher.final());
    const ciphertext = Buffer.concat(chunks);
    chunks.length = 0;
    const serialized = JSON.stringify({ format: FORMAT, version: FORMAT_VERSION, orgId: bundle.orgId,
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    return { serialized, digest: digest.digest('hex') };
  } finally { key.fill(0); }
}

export async function sealRecoveryBundle(bundle: TeamRecoveryBundle, password: string): Promise<string> {
  return (await seal(bundle, password)).serialized;
}

export async function openRecoveryBundle(serialized: string, password: string, orgId: string): Promise<TeamRecoveryBundle> {
  return (await unseal(serialized, password, orgId)).bundle;
}

async function unseal(serialized: string, password: string, orgId: string): Promise<{ bundle: TeamRecoveryBundle; digest: string }> {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > Math.ceil(MAX_BYTES * 4 / 3) + 4096) {
    throw new Error('Recovery bundle exceeds the 128 MiB limit');
  }
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(serialized); } catch { throw invalidFormat(); }
  if (!envelope || envelope.format !== FORMAT) throw invalidFormat();
  if (envelope.version === 1) throw new Error('This recovery bundle was saved by an earlier preview of Nimbalyst and cannot be opened. Save a new bundle on the device that holds its sources.');
  if (envelope.version !== FORMAT_VERSION) throw invalidFormat();
  if (envelope.orgId !== orgId) throw new Error('Recovery bundle belongs to a different organization');
  const read = (field: string, length?: number) => {
    const value = envelope[field];
    if (typeof value !== 'string' || !value || !base64.test(value)) throw new Error('Invalid recovery bundle format');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) throw new Error('Invalid recovery bundle format');
    if ((length !== undefined && bytes.byteLength !== length) || bytes.byteLength > MAX_BYTES) throw new Error('Invalid recovery bundle format');
    return bytes;
  };
  const salt = read('salt', 16), iv = read('iv', 12), tag = read('tag', 16), ciphertext = read('ciphertext');
  const key = await deriveKey(password, salt);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(orgId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { throw new Error('Cannot unlock recovery bundle: check its passphrase and integrity'); }
  finally { key.fill(0); }
  try {
    const digest = createHash('sha256').update(plaintext).digest('hex');
    let parsed: unknown;
    try { parsed = JSON.parse(plaintext.toString('utf8')); } catch { throw invalidFormat(); }
    return { bundle: validateBundle(hydrate(parsed), orgId), digest };
  } finally { plaintext.fill(0); }
}

/** Exclusive creation retains any older artifact; success includes a fresh disk read and authenticated unlock. */
export async function writeRecoveryBundle(filename: string, bundle: TeamRecoveryBundle, password: string): Promise<void> {
  // The OS save dialog may already have offered "Replace". Refuse before the
  // passphrase is stretched and the bundle encrypted, and again atomically below.
  if (await lstat(filename).then(() => true, () => false)) throw new Error(EXISTS_MESSAGE);
  const { serialized, digest } = await seal(bundle, password);
  let file;
  try { file = await open(filename, 'wx', 0o600); } catch (error) { throw exclusiveCreateError(error); }
  try { await file.writeFile(serialized, 'utf8'); await file.sync(); }
  finally { await file.close(); }
  const restored = await readSealedBundle(filename, password, bundle.orgId);
  if (restored.digest !== digest) throw new Error('Recovery artifact verification failed; source data was retained');
}

export async function readRecoveryBundle(filename: string, password: string, orgId: string): Promise<TeamRecoveryBundle> {
  return (await readSealedBundle(filename, password, orgId)).bundle;
}

async function readSealedBundle(filename: string, password: string, orgId: string): Promise<{ bundle: TeamRecoveryBundle; digest: string }> {
  const file = await open(filename, 'r');
  try {
    const maximum = Math.ceil(MAX_BYTES * 4 / 3) + 4096;
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Invalid or oversized recovery bundle');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximum) throw new Error('Recovery bundle exceeds the 128 MiB limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return await unseal(Buffer.concat(chunks).toString('utf8'), password, orgId);
  } finally { await file.close(); }
}
