import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { link, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'fs/promises';
import { isAbsolute, join, resolve } from 'path';

const DEFAULT_ACQUIRE_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_MS = 10;
const DEFAULT_RECOVERY_GRACE_MS = 30_000;
const IDENTITY_TIMEOUT_MS = 1_000;
const MAX_IDENTITY_OUTPUT_BYTES = 4_096;
const MAX_RECORD_BYTES = 4_096;
const RECORD_VERSION = 2;
const SEQUENCE_WIDTH = 12;
const MAX_SEQUENCE = 999_999_999_999;
const EPOCH_WIDTH = 8;
const MAX_EPOCH = 99_999_999;
const SHARED_PROCESS_IDENTITY_KEY = Symbol.for(
  'nimbalyst.host-control-mutation-coordinator.current-process-identity.v1',
);

interface SharedProcessIdentityState {
  pid: number;
  promise?: Promise<string | null>;
  value?: string;
}

export interface HostControlStoreIdentity {
  storeId: string;
  authorityRoot: string;
}

interface EpochRecord {
  version: typeof RECORD_VERSION;
  generation: number;
  token: string;
  storeDigest: string;
  operationDigest: string;
  checksum: string;
}

interface LockRecord {
  version: typeof RECORD_VERSION;
  epochGeneration: number;
  epochToken: string;
  sequence: number;
  pid: number;
  processIdentity: string;
  token: string;
  storeDigest: string;
  operationDigest: string;
  checksum: string;
}

interface ReleaseRecord {
  version: typeof RECORD_VERSION;
  epochGeneration: number;
  epochToken: string;
  sequence: number;
  token: string;
  storeDigest: string;
  operationDigest: string;
  checksum: string;
}

interface CheckpointRecord {
  version: typeof RECORD_VERSION;
  epochGeneration: number;
  epochToken: string;
  throughSequence: number;
  storeDigest: string;
  operationDigest: string;
  checksum: string;
}

export interface HostControlOperationNamespace {
  directory: string;
  storeDigest: string;
  operationDigest: string;
}

interface PublishedClaim {
  path: string;
  record: LockRecord;
  namespace: HostControlOperationNamespace;
}

export interface HostControlMutationCoordinatorOptions {
  acquireTimeoutMs?: number;
  retryMs?: number;
  recoveryGraceMs?: number;
  pid?: number;
  processIdentity?: string;
  isProcessAlive?: (pid: number) => boolean;
  getProcessIdentity?: (pid: number) => Promise<string | null>;
  randomToken?: () => string;
  now?: () => number;
  onContention?: (operationDigest: string) => void;
  /** Test seam after a complete private record exists but before atomic publication. */
  afterClaimPrepared?: (input: PublishedClaim & { temporaryPath: string }) => Promise<void> | void;
  /** Test seam after the immutable claim is visible. */
  afterClaimPublished?: (input: PublishedClaim) => Promise<void> | void;
  /** Test seam immediately before the exact-token release record is published. */
  beforeReleasePublished?: (input: PublishedClaim) => Promise<void> | void;
}

export interface HostControlMutationCoordinator {
  /**
   * Cross-process exclusion for one immutable durable operation. The durable
   * store identity selects the canonical filesystem namespace; process temp
   * environment never participates. Callers perform their database-current-
   * time authority check and synchronously enter native code inside `action`.
   */
  withOperationLock<T>(
    storeIdentity: HostControlStoreIdentity,
    operationKey: string,
    action: () => Promise<T>,
  ): Promise<T>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function checksum(value: object): string {
  return sha256(JSON.stringify(value));
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function execFileBounded(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: IDENTITY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_IDENTITY_OUTPUT_BYTES,
    }, (error, stdout) => {
      if (error) return resolvePromise(null);
      const value = stdout.trim();
      return resolvePromise(
        value && Buffer.byteLength(value, 'utf8') <= MAX_IDENTITY_OUTPUT_BYTES ? value : null,
      );
    });
  });
}

async function defaultGetProcessIdentity(pid: number): Promise<string | null> {
  if (!defaultIsProcessAlive(pid)) return null;
  try {
    if (process.platform === 'linux') {
      const [bootId, statLine] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const closeParen = statLine.lastIndexOf(')');
      const fieldsAfterCommand = statLine.slice(closeParen + 2).trim().split(/\s+/);
      const startTicks = fieldsAfterCommand[19];
      return bootId.trim() && startTicks ? `linux:${bootId.trim()}:${startTicks}` : null;
    }
    if (process.platform === 'win32') {
      const script = [
        "$os=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks",
        `$p=(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        "[Console]::Out.Write(\"$os`:$p\")",
      ].join(';');
      const value = await execFileBounded('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', script,
      ]);
      return value ? `win32:${value}` : null;
    }
    const [boot, started] = await Promise.all([
      execFileBounded('/usr/sbin/sysctl', ['-n', 'kern.boottime']),
      execFileBounded('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]),
    ]);
    return boot && started ? `${process.platform}:${boot}:${started}` : null;
  } catch {
    return null;
  }
}

function sharedCurrentProcessIdentity(
  pid: number,
  resolveIdentity: (pid: number) => Promise<string | null>,
): Promise<string | null> {
  const shared = globalThis as unknown as Record<PropertyKey, unknown>;
  let state = shared[SHARED_PROCESS_IDENTITY_KEY] as SharedProcessIdentityState | undefined;
  if (!state || state.pid !== pid) {
    state = { pid };
    shared[SHARED_PROCESS_IDENTITY_KEY] = state;
  }
  if (state.value) return Promise.resolve(state.value);
  if (state.promise) return state.promise;

  const pending = resolveIdentity(pid).then((identity) => {
    if (isBoundedString(identity)) {
      state!.value = identity;
    } else {
      state!.promise = undefined;
    }
    return identity;
  }, (error: unknown) => {
    state!.promise = undefined;
    throw error;
  });
  state.promise = pending;
  return pending;
}

function boundedDelay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isBoundedString(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function assertOperationKey(operationKey: string): void {
  if (!operationKey || operationKey.length > 1_000) {
    throw new Error('host_control_mutation_operation_key_invalid');
  }
}

function assertBeforeDeadline(now: () => number, startedAt: number, timeoutMs: number, digest: string): void {
  if (now() - startedAt >= timeoutMs) {
    throw new Error(`host_control_mutation_lock_timeout:${digest.slice(0, 12)}`);
  }
}

export async function resolveHostControlOperationNamespace(
  identity: HostControlStoreIdentity,
  operationKey: string,
): Promise<HostControlOperationNamespace> {
  assertOperationKey(operationKey);
  if (!isBoundedString(identity?.storeId, 512) || !isBoundedString(identity?.authorityRoot, 2_000)) {
    throw new Error('host_control_mutation_store_identity_invalid');
  }
  if (!isAbsolute(identity.authorityRoot)) {
    throw new Error('host_control_mutation_authority_root_not_absolute');
  }
  await mkdir(resolve(identity.authorityRoot), { recursive: true });
  const canonicalRootRaw = await realpath(resolve(identity.authorityRoot));
  const canonicalRoot = process.platform === 'win32'
    ? canonicalRootRaw.replace(/\\/g, '/').toLowerCase()
    : canonicalRootRaw;
  const storeDigest = sha256(`${identity.storeId}\0${canonicalRoot}`);
  const operationDigest = sha256(`${storeDigest}\0${operationKey}`);
  const directory = join(canonicalRootRaw, `store-${sha256(identity.storeId).slice(0, 32)}`,
    `operation-${operationDigest}`);
  await mkdir(directory, { recursive: true });
  return { directory, storeDigest, operationDigest };
}

function epochPrefix(generation: number, token: string): string {
  return `e${String(generation).padStart(EPOCH_WIDTH, '0')}-${sha256(token).slice(0, 24)}`;
}

function epochMarkerName(generation: number, token: string): string {
  return `epoch-${String(generation).padStart(EPOCH_WIDTH, '0')}-${token}.json`;
}

function claimName(epoch: EpochRecord, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > MAX_SEQUENCE) {
    throw new Error(`host_control_mutation_sequence_exhausted:${epoch.operationDigest.slice(0, 12)}`);
  }
  return `${epochPrefix(epoch.generation, epoch.token)}.${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.claim`;
}

function releaseName(epoch: EpochRecord, sequence: number): string {
  return `${epochPrefix(epoch.generation, epoch.token)}.${String(sequence).padStart(SEQUENCE_WIDTH, '0')}.release`;
}

function checkpointName(epoch: EpochRecord, throughSequence: number, token: string): string {
  return `${epochPrefix(epoch.generation, epoch.token)}.checkpoint-${String(throughSequence).padStart(SEQUENCE_WIDTH, '0')}-${token}.json`;
}

function sequenceFromName(name: string, epoch: EpochRecord, suffix: 'claim' | 'release'): number | null {
  const escaped = epochPrefix(epoch.generation, epoch.token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = name.match(new RegExp(`^${escaped}\\.(\\d{${SEQUENCE_WIDTH}})\\.${suffix}$`));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_SEQUENCE ? value : null;
}

function checkpointSequence(name: string, epoch: EpochRecord): number | null {
  const escaped = epochPrefix(epoch.generation, epoch.token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = name.match(new RegExp(
    `^${escaped}\\.checkpoint-(\\d{${SEQUENCE_WIDTH}})-[A-Za-z0-9-]{1,100}\\.json$`,
  ));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SEQUENCE ? value : null;
}

async function readBounded(path: string): Promise<string> {
  const info = await stat(path);
  if (info.size <= 0 || info.size > MAX_RECORD_BYTES) throw new Error('record_size_invalid');
  return readFile(path, 'utf8');
}

async function publishCompleteRecord(path: string, value: object, token: string): Promise<string> {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('host_control_mutation_record_too_large');
  }
  const temporaryPath = `${path}.${token}.tmp`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporaryPath;
}

async function removeExact(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function atomicPublish(path: string, value: object, token: string): Promise<'published' | 'exists'> {
  const temporaryPath = await publishCompleteRecord(path, value, token);
  try {
    await link(temporaryPath, path);
    return 'published';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw error;
  } finally {
    await removeExact(temporaryPath);
  }
}

function validChecksum<T extends { checksum: string }>(record: T): boolean {
  const { checksum: actual, ...unsigned } = record;
  return actual === checksum(unsigned);
}

async function ownerIsLive(
  value: Partial<LockRecord>,
  isProcessAlive: (pid: number) => boolean,
  getProcessIdentity: (pid: number) => Promise<string | null>,
): Promise<boolean | 'indeterminate'> {
  if (!Number.isInteger(value.pid) || (value.pid ?? 0) <= 0 || !isBoundedString(value.processIdentity)) {
    return false;
  }
  if (!isProcessAlive(value.pid!)) return false;
  const identity = await getProcessIdentity(value.pid!);
  if (identity === null) return 'indeterminate';
  return identity === value.processIdentity;
}

async function recoverMalformed(input: {
  path: string;
  name: string;
  namespace: HostControlOperationNamespace;
  recoveryGraceMs: number;
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
  getProcessIdentity: (pid: number) => Promise<string | null>;
  randomToken: () => string;
}): Promise<void> {
  let raw = '';
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(input.path);
    if (info.size > 0 && info.size <= MAX_RECORD_BYTES) raw = await readFile(input.path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let partial: Partial<LockRecord> = {};
  try { partial = JSON.parse(raw) as Partial<LockRecord>; } catch { /* malformed by definition */ }
  const live = await ownerIsLive(partial, input.isProcessAlive, input.getProcessIdentity);
  if (live === true || live === 'indeterminate' || input.now() - info.mtimeMs < input.recoveryGraceMs) {
    throw new Error(`host_control_mutation_lock_indeterminate:${input.namespace.operationDigest.slice(0, 12)}`);
  }
  const observedHash = sha256(Buffer.from(raw, 'utf8'));
  const recoveryPath = join(input.namespace.directory, `recovered-${sha256(`${input.name}\0${observedHash}`)}.json`);
  const token = input.randomToken();
  const unsigned = {
    version: RECORD_VERSION,
    name: input.name,
    observedHash,
    observedBytes: Buffer.byteLength(raw, 'utf8'),
    storeDigest: input.namespace.storeDigest,
    operationDigest: input.namespace.operationDigest,
  };
  await atomicPublish(recoveryPath, { ...unsigned, checksum: checksum(unsigned) }, token);
}

function hasRecoveryMarker(names: string[], name: string, raw: string): boolean {
  const observedHash = sha256(Buffer.from(raw, 'utf8'));
  return names.includes(`recovered-${sha256(`${name}\0${observedHash}`)}.json`);
}

async function readEpochs(
  namespace: HostControlOperationNamespace,
  names: string[],
  recover: (path: string, name: string) => Promise<void>,
): Promise<EpochRecord[]> {
  const epochs: EpochRecord[] = [];
  for (const name of names) {
    const match = name.match(/^epoch-(\d{8})-([A-Za-z0-9-]{1,100})\.json$/);
    if (!match) continue;
    const path = join(namespace.directory, name);
    let raw = '';
    try {
      raw = await readBounded(path);
      const parsed = JSON.parse(raw) as EpochRecord;
      if (
        parsed.version !== RECORD_VERSION
        || parsed.generation !== Number(match[1])
        || parsed.token !== match[2]
        || parsed.storeDigest !== namespace.storeDigest
        || parsed.operationDigest !== namespace.operationDigest
        || !validChecksum(parsed)
      ) throw new Error('epoch_invalid');
      epochs.push(parsed);
    } catch {
      if (!hasRecoveryMarker(names, name, raw)) await recover(path, name);
    }
  }
  return epochs;
}

async function publishEpoch(
  namespace: HostControlOperationNamespace,
  generation: number,
  randomToken: () => string,
): Promise<void> {
  if (!Number.isSafeInteger(generation) || generation <= 0 || generation > MAX_EPOCH) {
    throw new Error(`host_control_mutation_epoch_exhausted:${namespace.operationDigest.slice(0, 12)}`);
  }
  const token = randomToken();
  const unsigned = {
    version: RECORD_VERSION,
    generation,
    token,
    storeDigest: namespace.storeDigest,
    operationDigest: namespace.operationDigest,
  };
  await atomicPublish(
    join(namespace.directory, epochMarkerName(generation, token)),
    { ...unsigned, checksum: checksum(unsigned) },
    token,
  );
}

function canonicalEpoch(epochs: EpochRecord[]): EpochRecord | null {
  return [...epochs].sort((left, right) => (
    right.generation - left.generation || left.token.localeCompare(right.token)
  ))[0] ?? null;
}

function assertLockRecord(record: LockRecord, namespace: HostControlOperationNamespace, epoch: EpochRecord, sequence: number): void {
  if (
    record.version !== RECORD_VERSION
    || record.epochGeneration !== epoch.generation
    || record.epochToken !== epoch.token
    || record.sequence !== sequence
    || !Number.isInteger(record.pid)
    || record.pid <= 0
    || !isBoundedString(record.processIdentity)
    || !isBoundedString(record.token)
    || record.storeDigest !== namespace.storeDigest
    || record.operationDigest !== namespace.operationDigest
    || !validChecksum(record)
  ) throw new Error('claim_invalid');
}

function assertReleaseRecord(
  record: ReleaseRecord,
  claim: LockRecord,
  namespace: HostControlOperationNamespace,
  epoch: EpochRecord,
): void {
  if (
    record.version !== RECORD_VERSION
    || record.epochGeneration !== epoch.generation
    || record.epochToken !== epoch.token
    || record.sequence !== claim.sequence
    || record.token !== claim.token
    || record.storeDigest !== namespace.storeDigest
    || record.operationDigest !== namespace.operationDigest
    || !validChecksum(record)
  ) throw new Error('release_invalid');
}

interface ClaimScan {
  checkpoint: number;
  active: LockRecord[];
  closed: Array<{ sequence: number; claimPath: string; releasePath: string }>;
  highestSequence: number;
}

async function scanClaims(input: {
  namespace: HostControlOperationNamespace;
  epoch: EpochRecord;
  names: string[];
  recover: (path: string, name: string) => Promise<void>;
  isProcessAlive: (pid: number) => boolean;
  getProcessIdentity: (pid: number) => Promise<string | null>;
}): Promise<ClaimScan> {
  let checkpoint = 0;
  for (const name of input.names) {
    const sequence = checkpointSequence(name, input.epoch);
    if (sequence === null) continue;
    let raw = '';
    try {
      raw = await readBounded(join(input.namespace.directory, name));
      const parsed = JSON.parse(raw) as CheckpointRecord;
      if (
        parsed.version !== RECORD_VERSION
        || parsed.epochGeneration !== input.epoch.generation
        || parsed.epochToken !== input.epoch.token
        || parsed.throughSequence !== sequence
        || parsed.storeDigest !== input.namespace.storeDigest
        || parsed.operationDigest !== input.namespace.operationDigest
        || !validChecksum(parsed)
      ) throw new Error('checkpoint_invalid');
      checkpoint = Math.max(checkpoint, sequence);
    } catch {
      if (!hasRecoveryMarker(input.names, name, raw)) {
        await input.recover(join(input.namespace.directory, name), name);
      }
    }
  }

  const active: LockRecord[] = [];
  const closed: ClaimScan['closed'] = [];
  let highestSequence = checkpoint;
  const sequences = input.names
    .map((name) => sequenceFromName(name, input.epoch, 'claim'))
    .filter((value): value is number => value !== null && value > checkpoint)
    .sort((left, right) => left - right);
  for (const sequence of sequences) {
    highestSequence = Math.max(highestSequence, sequence);
    const claimFile = claimName(input.epoch, sequence);
    const claimPath = join(input.namespace.directory, claimFile);
    const releaseFile = releaseName(input.epoch, sequence);
    const releasePath = join(input.namespace.directory, releaseFile);
    let raw = '';
    let claim: LockRecord;
    try {
      raw = await readBounded(claimPath);
      claim = JSON.parse(raw) as LockRecord;
      assertLockRecord(claim, input.namespace, input.epoch, sequence);
    } catch {
      if (!hasRecoveryMarker(input.names, claimFile, raw)) await input.recover(claimPath, claimFile);
      closed.push({ sequence, claimPath, releasePath });
      continue;
    }

    let live: boolean | 'indeterminate' | undefined;
    let releaseRaw = '';
    try {
      releaseRaw = await readBounded(releasePath);
      const release = JSON.parse(releaseRaw) as ReleaseRecord;
      assertReleaseRecord(release, claim, input.namespace, input.epoch);
      closed.push({ sequence, claimPath, releasePath });
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        live = await ownerIsLive(claim, input.isProcessAlive, input.getProcessIdentity);
        if (live === true || live === 'indeterminate') {
          throw new Error(`host_control_mutation_lock_indeterminate:${input.namespace.operationDigest.slice(0, 12)}`);
        }
        if (!hasRecoveryMarker(input.names, releaseFile, releaseRaw)) {
          await input.recover(releasePath, releaseFile);
        }
        closed.push({ sequence, claimPath, releasePath });
        continue;
      }
    }
    live ??= await ownerIsLive(claim, input.isProcessAlive, input.getProcessIdentity);
    if (live === 'indeterminate') {
      throw new Error(`host_control_mutation_lock_indeterminate:${input.namespace.operationDigest.slice(0, 12)}`);
    }
    if (live) active.push(claim);
    else closed.push({ sequence, claimPath, releasePath });
  }
  return { checkpoint, active, closed, highestSequence };
}

async function publishCheckpoint(
  namespace: HostControlOperationNamespace,
  epoch: EpochRecord,
  throughSequence: number,
  randomToken: () => string,
): Promise<string | null> {
  if (throughSequence <= 0) return null;
  const token = randomToken();
  const unsigned = {
    version: RECORD_VERSION,
    epochGeneration: epoch.generation,
    epochToken: epoch.token,
    throughSequence,
    storeDigest: namespace.storeDigest,
    operationDigest: namespace.operationDigest,
  };
  const path = join(namespace.directory, checkpointName(epoch, throughSequence, token));
  await atomicPublish(path, { ...unsigned, checksum: checksum(unsigned) }, token);
  return path;
}

async function compactClosedPrefix(
  namespace: HostControlOperationNamespace,
  epoch: EpochRecord,
  scan: ClaimScan,
  beforeSequence: number,
  randomToken: () => string,
): Promise<void> {
  const prefix = scan.closed.filter((entry) => entry.sequence < beforeSequence);
  if (prefix.length === 0) {
    if (scan.checkpoint <= 0) return;
    const names = await readdir(namespace.directory);
    for (const name of names) {
      const closedClaim = sequenceFromName(name, epoch, 'claim');
      const closedRelease = sequenceFromName(name, epoch, 'release');
      if (
        (closedClaim !== null && closedClaim <= scan.checkpoint)
        || (closedRelease !== null && closedRelease <= scan.checkpoint)
      ) await removeExact(join(namespace.directory, name));
    }
    return;
  }
  const throughSequence = Math.max(scan.checkpoint, ...prefix.map((entry) => entry.sequence));
  const retainedCheckpoint = await publishCheckpoint(namespace, epoch, throughSequence, randomToken);
  for (const entry of prefix) {
    await removeExact(entry.claimPath);
    await removeExact(entry.releasePath);
  }
  const names = await readdir(namespace.directory);
  for (const name of names) {
    const checkpoint = checkpointSequence(name, epoch);
    if (checkpoint !== null && join(namespace.directory, name) !== retainedCheckpoint) {
      await removeExact(join(namespace.directory, name));
    }
    const closedClaim = sequenceFromName(name, epoch, 'claim');
    const closedRelease = sequenceFromName(name, epoch, 'release');
    if (
      (closedClaim !== null && closedClaim <= throughSequence)
      || (closedRelease !== null && closedRelease <= throughSequence)
    ) await removeExact(join(namespace.directory, name));
    if (name.startsWith('recovered-')) await removeExact(join(namespace.directory, name));
  }
}

async function compactObsoleteEpochs(
  namespace: HostControlOperationNamespace,
  currentEpoch: EpochRecord,
  names: string[],
): Promise<void> {
  for (const name of names) {
    const epochMarker = name.match(/^epoch-(\d{8})-/);
    const epochRecord = name.match(/^e(\d{8})-/);
    const generation = Number(epochMarker?.[1] ?? epochRecord?.[1] ?? NaN);
    if (Number.isSafeInteger(generation) && generation < currentEpoch.generation) {
      // A higher immutable epoch permanently fences every lower-epoch claim.
      // Exact-path removal is therefore compaction, never authority transfer.
      await removeExact(join(namespace.directory, name));
    }
  }
}

async function compactAbandonedPrivateRecords(input: {
  namespace: HostControlOperationNamespace;
  names: string[];
  recoveryGraceMs: number;
  now: () => number;
  isProcessAlive: (pid: number) => boolean;
  getProcessIdentity: (pid: number) => Promise<string | null>;
  randomToken: () => string;
}): Promise<void> {
  for (const name of input.names.filter((candidate) => candidate.endsWith('.tmp'))) {
    const path = join(input.namespace.directory, name);
    let raw = '';
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
      if (info.size > 0 && info.size <= MAX_RECORD_BYTES) raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let partial: Partial<LockRecord> = {};
    try { partial = JSON.parse(raw) as Partial<LockRecord>; } catch { /* private partial */ }
    const live = await ownerIsLive(partial, input.isProcessAlive, input.getProcessIdentity);
    if (
      live === true
      || live === 'indeterminate'
      || input.now() - info.mtimeMs < input.recoveryGraceMs
    ) continue;
    // Rename consumes the exact observed private inode. A delayed creator can
    // no longer publish it and must retry; no pathname is deleted by stale read.
    const quarantine = join(
      input.namespace.directory,
      `private-quarantine-${sha256(`${name}\0${input.randomToken()}`)}.tmp-dead`,
    );
    try {
      await rename(path, quarantine);
      await removeExact(quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Store-bound, atomically published cross-process lock journal. History is
 * partitioned by canonical store+operation, closed prefixes are checkpointed
 * and removed, malformed dead records receive content-bound recovery markers,
 * and exhausted sequences advance to a new immutable epoch.
 */
export function createHostControlMutationCoordinator(
  options: HostControlMutationCoordinatorOptions = {},
): HostControlMutationCoordinator {
  const acquireTimeoutMs = Math.max(50, options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS);
  const retryMs = Math.max(1, options.retryMs ?? DEFAULT_RETRY_MS);
  const recoveryGraceMs = Math.max(0, options.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS);
  const ownerPid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const getProcessIdentity = options.getProcessIdentity ?? defaultGetProcessIdentity;
  const randomToken = options.randomToken ?? randomUUID;
  const now = options.now ?? Date.now;

  return {
    async withOperationLock<T>(
      storeIdentity: HostControlStoreIdentity,
      operationKey: string,
      action: () => Promise<T>,
    ): Promise<T> {
      const namespace = await resolveHostControlOperationNamespace(storeIdentity, operationKey);
      const ownerIdentity = options.processIdentity ?? await (
        ownerPid === process.pid
          ? sharedCurrentProcessIdentity(ownerPid, getProcessIdentity)
          : getProcessIdentity(ownerPid)
      );
      if (!isBoundedString(ownerIdentity)) {
        throw new Error(`host_control_mutation_owner_identity_unavailable:${namespace.operationDigest.slice(0, 12)}`);
      }
      const startedAt = now();
      const getClaimProcessIdentity = (pid: number): Promise<string | null> => (
        pid === ownerPid ? Promise.resolve(ownerIdentity) : getProcessIdentity(pid)
      );
      const recover = (path: string, name: string) => recoverMalformed({
        path,
        name,
        namespace,
        recoveryGraceMs,
        now,
        isProcessAlive,
        getProcessIdentity,
        randomToken,
      });

      for (;;) {
        assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
        let names = await readdir(namespace.directory);
        await compactAbandonedPrivateRecords({
          namespace,
          names,
          recoveryGraceMs,
          now,
          isProcessAlive,
          getProcessIdentity,
          randomToken,
        });
        assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
        names = await readdir(namespace.directory);
        let epochs = await readEpochs(namespace, names, recover);
        assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
        let epoch = canonicalEpoch(epochs);
        if (!epoch) {
          await publishEpoch(namespace, 1, randomToken);
          assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
          await boundedDelay(retryMs);
          continue;
        }
        await compactObsoleteEpochs(namespace, epoch, names);
        assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);

        let scan = await scanClaims({
          namespace, epoch, names, recover, isProcessAlive, getProcessIdentity: getClaimProcessIdentity,
        });
        assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
        if (scan.highestSequence >= MAX_SEQUENCE) {
          if (scan.active.length > 0) {
            options.onContention?.(namespace.operationDigest);
            await boundedDelay(retryMs);
            continue;
          }
          if (epoch.generation >= MAX_EPOCH) {
            throw new Error(`host_control_mutation_epoch_exhausted:${namespace.operationDigest.slice(0, 12)}`);
          }
          await publishEpoch(namespace, epoch.generation + 1, randomToken);
          assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
          await boundedDelay(retryMs);
          continue;
        }

        const sequence = scan.highestSequence + 1;
        // Overflow is rejected before claimName can create any pathname.
        if (!Number.isSafeInteger(sequence) || sequence > MAX_SEQUENCE) {
          throw new Error(`host_control_mutation_sequence_exhausted:${namespace.operationDigest.slice(0, 12)}`);
        }
        const token = randomToken();
        const unsigned: Omit<LockRecord, 'checksum'> = {
          version: RECORD_VERSION,
          epochGeneration: epoch.generation,
          epochToken: epoch.token,
          sequence,
          pid: ownerPid,
          processIdentity: ownerIdentity,
          token,
          storeDigest: namespace.storeDigest,
          operationDigest: namespace.operationDigest,
        };
        const record: LockRecord = { ...unsigned, checksum: checksum(unsigned) };
        const path = join(namespace.directory, claimName(epoch, sequence));
        assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
        const temporaryPath = await publishCompleteRecord(path, record, token);
        let published = false;
        try {
          await options.afterClaimPrepared?.({ path, record, namespace, temporaryPath });
          assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
          await link(temporaryPath, path);
          published = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        } finally {
          await removeExact(temporaryPath);
        }
        if (!published) {
          assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
          await boundedDelay(retryMs);
          continue;
        }

        const claim: PublishedClaim = { path, record, namespace };
        let releaseHookError: unknown;
        try {
          await options.afterClaimPublished?.(claim);
          for (;;) {
            assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
            names = await readdir(namespace.directory);
            epochs = await readEpochs(namespace, names, recover);
            assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
            const currentEpoch = canonicalEpoch(epochs);
            if (
              !currentEpoch
              || currentEpoch.generation !== epoch.generation
              || currentEpoch.token !== epoch.token
            ) break;
            scan = await scanClaims({
              namespace, epoch, names, recover, isProcessAlive, getProcessIdentity: getClaimProcessIdentity,
            });
            assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
            const winner = [...scan.active].sort((left, right) => left.sequence - right.sequence)[0];
            if (winner?.sequence === sequence && winner.token === token) {
              await compactClosedPrefix(namespace, epoch, scan, sequence, randomToken);
              assertBeforeDeadline(now, startedAt, acquireTimeoutMs, namespace.operationDigest);
              return await action();
            }
            options.onContention?.(namespace.operationDigest);
            await boundedDelay(retryMs);
          }
        } finally {
          try {
            await options.beforeReleasePublished?.(claim);
          } catch (error) {
            releaseHookError = error;
          }
          const releaseUnsigned = {
            version: RECORD_VERSION,
            epochGeneration: epoch.generation,
            epochToken: epoch.token,
            sequence,
            token,
            storeDigest: namespace.storeDigest,
            operationDigest: namespace.operationDigest,
          };
          await atomicPublish(
            join(namespace.directory, releaseName(epoch, sequence)),
            { ...releaseUnsigned, checksum: checksum(releaseUnsigned) },
            token,
          );
          if (releaseHookError) throw releaseHookError;
        }
        if (releaseHookError) throw releaseHookError;
      }
    },
  };
}

export const hostControlMutationCoordinator = createHostControlMutationCoordinator();
