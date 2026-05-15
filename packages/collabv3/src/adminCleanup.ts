/**
 * Admin DO Cleanup
 *
 * Enumerates a personal DO namespace via the Cloudflare API and purges
 * orphaned or stale instances. Required because Cloudflare's Workers runtime
 * has no native "list all DOs" capability -- this calls the management API,
 * then dispatches per-DO HTTP fetches to the standard /internal/staleness
 * and /delete-account paths.
 *
 * Endpoint: POST /admin/cleanup-do
 *
 * Auth: Cloudflare Access. The worker validates the Cf-Access-Jwt-Assertion
 * header (signed by the team's Access JWKS) on every request and rejects
 * anything missing or with a mismatched audience. This means the endpoint
 * stops working entirely if Access is ever removed from in front of /admin/*,
 * instead of falling back to a shared bearer secret. Configure two env values:
 *   CF_ACCESS_TEAM_DOMAIN  e.g. nimbalyst.cloudflareaccess.com
 *   CF_ACCESS_AUD          per-application AUD tag from the Access app
 *
 * Body:
 *   {
 *     class: "PersonalSessionRoom" | "PersonalIndexRoom" | "PersonalProjectSyncRoom",
 *     dryRun?: boolean,         // default true
 *     maxAgeMs?: number,        // default per-class TTL
 *     limit?: number,           // max DOs scanned per invocation; default 200
 *     cursor?: string | null    // CF API page cursor
 *   }
 *
 * Returns:
 *   {
 *     scanned, eligible, purged, errors[], nextCursor, done,
 *     stats: {
 *       withData, empty, orphaned,
 *       totalDatabaseSize, totalMessageCount, totalMessageBytes,
 *       totalMetadataCount, totalMetadataBytes,
 *       sizeBuckets[], messageCountBuckets[], ageBuckets[],
 *       topLargest[]
 *     }
 *   }
 *
 * Run repeatedly via the driver script (scripts/cleanup-orphan-dos.mjs) which
 * threads the cursor, accumulates totals, and prints a final stats summary.
 */

import type { Env } from './types';
import { createLogger } from './logger';
import { verifyAccessJwt } from './accessJwt';

const log = createLogger('adminCleanup');

const SUPPORTED_CLASSES = {
  // PersonalSessionRoom default kept in sync with SESSION_TTL_MS in
  // SessionRoom.ts (14 days). The cleanup script sweeps the same threshold the
  // alarm enforces so we accelerate reclamation for sessions whose alarm was
  // scheduled at the old 30-day cadence.
  PersonalSessionRoom: { binding: 'SESSION_ROOM', defaultMaxAgeMs: 14 * 24 * 60 * 60 * 1000 },
  PersonalIndexRoom: { binding: 'INDEX_ROOM', defaultMaxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  PersonalProjectSyncRoom: { binding: 'PROJECT_SYNC_ROOM', defaultMaxAgeMs: 90 * 24 * 60 * 60 * 1000 },
} as const;

type SupportedClass = keyof typeof SUPPORTED_CLASSES;

interface CleanupRequest {
  class: SupportedClass;
  dryRun?: boolean;
  maxAgeMs?: number;
  limit?: number;
  cursor?: string | null;
}

/**
 * Per-batch storage stats aggregated across every DO scanned in one worker
 * invocation. The driver script accumulates these across all batches and prints
 * a summary so we can answer "why is PersonalSessionRoom storage so large?"
 * without enumerating every DO client-side.
 *
 * Histogram bucket bounds:
 *   sizeBuckets        [0]=empty, [1]=<1KB, [2]=<10KB, [3]=<100KB,
 *                      [4]=<1MB, [5]=<10MB, [6]=>=10MB
 *   messageCountBuckets[0]=0, [1]=1-10, [2]=11-100, [3]=101-1000,
 *                      [4]=1001-10000, [5]=>10000
 *   ageBuckets         [0]=no updatedAt, [1]=<1d, [2]=<7d, [3]=<30d,
 *                      [4]=<90d, [5]=<365d, [6]=>=365d
 */
interface StorageStats {
  withData: number;
  empty: number;
  orphaned: number;
  totalDatabaseSize: number;
  totalMessageCount: number;
  totalMessageBytes: number;
  totalMetadataCount: number;
  totalMetadataBytes: number;
  // databaseSize of DOs that matched eligibility (orphan / stale / no-data)
  // and of DOs we actually purged. In dry-run, purgedBytes stays 0 but
  // eligibleBytes tells us how much we'd reclaim.
  eligibleBytes: number;
  purgedBytes: number;
  sizeBuckets: number[];
  messageCountBuckets: number[];
  ageBuckets: number[];
  topLargest: Array<{
    id: string;
    databaseSize: number;
    messageCount: number;
    updatedAt: number | null;
    newestMessageAt: number | null;
    oldestMessageAt: number | null;
  }>;
  /**
   * How many DOs have a non-trivial gap between `updatedAt` (server-bumped
   * on message insert) and `newestMessageAt` (max client-side created_at).
   * A large drift bucket suggests `updated_at` is being kept fresh by
   * something other than new messages (late-sync, ghost activity, etc.) and
   * is a poor freshness signal for cleanup. Buckets:
   *   [0]=no messages, [1]=<1d, [2]=1-7d, [3]=7-30d, [4]=30-90d, [5]=>=90d
   */
  updatedVsMessageDriftBuckets: number[];
}

const SIZE_BUCKET_BOUNDS = [1, 1024, 10 * 1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024];
const MESSAGE_COUNT_BUCKET_BOUNDS = [1, 11, 101, 1001, 10001];
const AGE_BUCKET_BOUNDS_MS = [
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  90 * 24 * 60 * 60 * 1000,
  365 * 24 * 60 * 60 * 1000,
];
const DRIFT_BUCKET_BOUNDS_MS = [
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  90 * 24 * 60 * 60 * 1000,
];
const TOP_LARGEST_LIMIT = 25;

function createStorageStats(): StorageStats {
  return {
    withData: 0,
    empty: 0,
    orphaned: 0,
    totalDatabaseSize: 0,
    totalMessageCount: 0,
    totalMessageBytes: 0,
    totalMetadataCount: 0,
    totalMetadataBytes: 0,
    eligibleBytes: 0,
    purgedBytes: 0,
    sizeBuckets: new Array(SIZE_BUCKET_BOUNDS.length + 1).fill(0),
    messageCountBuckets: new Array(MESSAGE_COUNT_BUCKET_BOUNDS.length + 1).fill(0),
    ageBuckets: new Array(AGE_BUCKET_BOUNDS_MS.length + 2).fill(0),
    updatedVsMessageDriftBuckets: new Array(DRIFT_BUCKET_BOUNDS_MS.length + 2).fill(0),
    topLargest: [],
  };
}

/** Find the first bucket whose upper bound exceeds the value. */
function bucketIndex(value: number, bounds: number[]): number {
  for (let i = 0; i < bounds.length; i++) {
    if (value < bounds[i]) return i;
  }
  return bounds.length;
}

interface CleanupResult {
  class: SupportedClass;
  dryRun: boolean;
  scanned: number;
  eligible: number;
  purged: number;
  errors: Array<{ id: string; error: string }>;
  nextCursor: string | null;
  done: boolean;
  stats: StorageStats;
}

// How many DOs to probe/purge in parallel. Each DO has its own 1,000 req/sec
// soft limit (per Cloudflare docs), and we hit each at most twice, so per-DO
// load is irrelevant. The cap exists only to keep one batch invocation's
// subrequest fan-out bounded (Workers Paid plan = 10,000 subrequests per
// invocation; batch=1000 at concurrency=25 needs nowhere near that).
const CONCURRENCY = 25;

// CF API page size bounds. The objects-list endpoint rejects `limit` values
// below CF_API_MIN_PAGE_SIZE with HTTP 400 "Malformed parameter: limit is too
// low" (observed with limit=25). The user-facing `--batch` flag bounds total
// scanning work per invocation in the loop below; CF page size is independent.
const CF_API_PAGE_SIZE = 1000;
const CF_API_MIN_PAGE_SIZE = 100;

async function processObject(
  obj: CfObject,
  namespace: DurableObjectNamespace,
  cutoff: number,
  dryRun: boolean,
  now: number,
  result: CleanupResult,
): Promise<void> {
  result.scanned++;
  if (!obj.hasStoredData) return;
  try {
    const id = namespace.idFromString(obj.id);
    const stub = namespace.get(id);
    const probe = await probeStaleness(stub);
    accumulateStats(result.stats, obj.id, probe, now);

    const isOrphan = probe.updatedAt === null;
    const isStale = probe.updatedAt !== null && probe.updatedAt < cutoff;
    const noData = !probe.hasData;
    if (!(isOrphan || isStale || noData)) return;

    result.eligible++;
    const eligibleBytes = probe.databaseSize ?? 0;
    result.stats.eligibleBytes += eligibleBytes;
    if (!dryRun) {
      await purgeDO(stub);
      result.purged++;
      result.stats.purgedBytes += eligibleBytes;
    }
  } catch (err) {
    result.errors.push({
      id: obj.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fold a single DO's probe into the batch's running aggregates. Top-largest is
 * kept as a small sorted array (descending by databaseSize); when it grows past
 * the limit we drop the smallest.
 */
function accumulateStats(
  stats: StorageStats,
  id: string,
  probe: StalenessProbe,
  now: number,
): void {
  if (probe.hasData) stats.withData++;
  else stats.empty++;
  if (probe.updatedAt === null) stats.orphaned++;

  const databaseSize = probe.databaseSize ?? 0;
  const messageCount = probe.messageCount ?? 0;
  const messageBytes = probe.messageBytes ?? 0;
  const metadataCount = probe.metadataCount ?? 0;
  const metadataBytes = probe.metadataBytes ?? 0;

  stats.totalDatabaseSize += databaseSize;
  stats.totalMessageCount += messageCount;
  stats.totalMessageBytes += messageBytes;
  stats.totalMetadataCount += metadataCount;
  stats.totalMetadataBytes += metadataBytes;

  stats.sizeBuckets[bucketIndex(databaseSize, SIZE_BUCKET_BOUNDS)]++;
  stats.messageCountBuckets[bucketIndex(messageCount, MESSAGE_COUNT_BUCKET_BOUNDS)]++;

  if (probe.updatedAt === null) {
    stats.ageBuckets[0]++;
  } else {
    stats.ageBuckets[1 + bucketIndex(now - probe.updatedAt, AGE_BUCKET_BOUNDS_MS)]++;
  }

  // Drift = how far updatedAt has run ahead of the newest message's created_at.
  // If both are present we measure the gap; if there are no messages we bucket
  // separately so it doesn't get confused with "drift = 0".
  const newestMessageAt = probe.newestMessageAt ?? null;
  if (probe.updatedAt !== null && newestMessageAt !== null) {
    const drift = Math.max(0, probe.updatedAt - newestMessageAt);
    stats.updatedVsMessageDriftBuckets[1 + bucketIndex(drift, DRIFT_BUCKET_BOUNDS_MS)]++;
  } else {
    stats.updatedVsMessageDriftBuckets[0]++;
  }

  if (databaseSize > 0) {
    insertTopLargest(stats.topLargest, {
      id,
      databaseSize,
      messageCount,
      updatedAt: probe.updatedAt,
      newestMessageAt,
      oldestMessageAt: probe.oldestMessageAt ?? null,
    });
  }
}

function insertTopLargest(
  list: StorageStats['topLargest'],
  entry: StorageStats['topLargest'][number],
): void {
  if (list.length >= TOP_LARGEST_LIMIT && entry.databaseSize <= list[list.length - 1].databaseSize) {
    return;
  }
  let i = 0;
  while (i < list.length && list[i].databaseSize > entry.databaseSize) i++;
  list.splice(i, 0, entry);
  if (list.length > TOP_LARGEST_LIMIT) list.length = TOP_LARGEST_LIMIT;
}

interface CfNamespace {
  id: string;
  name?: string;
  class?: string;
  script?: string;
}

interface CfObject {
  id: string;
  hasStoredData?: boolean;
}

interface CfListResponse<T> {
  result: T[];
  result_info?: { cursor?: string };
  success: boolean;
  errors?: Array<{ message: string }>;
}

/**
 * Look up the namespace_id for a DO class. Cached per worker isolate.
 */
const namespaceIdCache = new Map<string, string>();

async function findNamespaceId(env: Env, className: SupportedClass): Promise<string> {
  const cached = namespaceIdCache.get(className);
  if (cached) return cached;

  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/durable_objects/namespaces`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`CF API list-namespaces failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json<CfListResponse<CfNamespace>>();
  if (!data.success) {
    throw new Error(`CF API list-namespaces returned errors: ${JSON.stringify(data.errors)}`);
  }
  const match = data.result.find((ns) => ns.class === className);
  if (!match) {
    throw new Error(`No namespace found for class ${className}`);
  }
  namespaceIdCache.set(className, match.id);
  return match.id;
}

/**
 * List one page of DO instances for a namespace.
 */
async function listObjects(
  env: Env,
  namespaceId: string,
  cursor: string | null,
  limit: number,
): Promise<{ objects: CfObject[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', cursor);
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/durable_objects/namespaces/${namespaceId}/objects?${params}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`CF API list-objects failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json<CfListResponse<CfObject>>();
  if (!data.success) {
    throw new Error(`CF API list-objects returned errors: ${JSON.stringify(data.errors)}`);
  }
  return {
    objects: data.result,
    nextCursor: data.result_info?.cursor || null,
  };
}

interface StalenessProbe {
  updatedAt: number | null;
  hasData: boolean;
  // Optional fields populated by classes that report storage stats
  // (currently PersonalSessionRoom). Older probe responses omit these and the
  // aggregator treats them as zero.
  databaseSize?: number;
  messageCount?: number;
  messageBytes?: number;
  metadataCount?: number;
  metadataBytes?: number;
  oldestMessageAt?: number | null;
  newestMessageAt?: number | null;
}

/**
 * Probe a DO for staleness via /internal/staleness.
 */
async function probeStaleness(stub: DurableObjectStub): Promise<StalenessProbe> {
  const response = await stub.fetch(new Request('https://internal/internal/staleness'));
  if (!response.ok) {
    throw new Error(`staleness probe returned ${response.status}`);
  }
  return response.json<StalenessProbe>();
}

async function purgeDO(stub: DurableObjectStub): Promise<void> {
  const response = await stub.fetch(
    new Request('https://internal/delete-account', { method: 'DELETE' }),
  );
  if (!response.ok) {
    throw new Error(`delete-account returned ${response.status}`);
  }
}

/**
 * Main entry: handle POST /admin/cleanup-do.
 */
export async function handleAdminCleanup(request: Request, env: Env): Promise<Response> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
    return new Response('Admin cleanup is not configured (missing CF_ACCOUNT_ID or CF_API_TOKEN)', {
      status: 503,
    });
  }
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return new Response(
      'Admin cleanup is not configured (missing CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD)',
      { status: 503 },
    );
  }

  const identity = await verifyAccessJwt(request, {
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
    audience: env.CF_ACCESS_AUD,
  });
  if (!identity) {
    return new Response('Unauthorized: Cloudflare Access verification failed', { status: 401 });
  }

  let body: CleanupRequest;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const classConfig = SUPPORTED_CLASSES[body.class];
  if (!classConfig) {
    return new Response(
      `Unsupported class. Allowed: ${Object.keys(SUPPORTED_CLASSES).join(', ')}`,
      { status: 400 },
    );
  }

  const dryRun = body.dryRun ?? true;
  const maxAgeMs = body.maxAgeMs ?? classConfig.defaultMaxAgeMs;
  const limit = Math.max(1, Math.min(body.limit ?? 200, 1000));
  const cutoff = Date.now() - maxAgeMs;

  const namespace = env[classConfig.binding] as DurableObjectNamespace;
  const namespaceId = await findNamespaceId(env, body.class);

  const result: CleanupResult = {
    class: body.class,
    dryRun,
    scanned: 0,
    eligible: 0,
    purged: 0,
    errors: [],
    nextCursor: null,
    done: false,
    stats: createStorageStats(),
  };

  // Pinned at the start of the invocation so every DO in this batch is bucketed
  // against the same `now`; otherwise the age histogram drifts as the batch runs.
  const now = Date.now();
  let cursor: string | null = body.cursor ?? null;
  let firstPage = true;

  // Page through CF API until we either hit the per-invocation `limit` of
  // scanned DOs or run out of objects. The driver script will re-invoke us
  // with the returned `nextCursor` until `done: true`.
  while (result.scanned < limit) {
    const remaining = limit - result.scanned;
    const pageSize = Math.min(CF_API_PAGE_SIZE, Math.max(remaining, CF_API_MIN_PAGE_SIZE));
    const { objects, nextCursor }: { objects: CfObject[]; nextCursor: string | null } = await listObjects(env, namespaceId, cursor, pageSize);

    if (firstPage && objects.length === 0 && !cursor) {
      // Empty namespace.
      result.done = true;
      break;
    }
    firstPage = false;

    // Probe (and optionally purge) DOs in bounded-concurrency chunks. JS is
    // single-threaded so the shared result counters mutate safely between awaits.
    for (let i = 0; i < objects.length; i += CONCURRENCY) {
      const chunk = objects.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map((obj) => processObject(obj, namespace, cutoff, dryRun, now, result)),
      );
    }

    cursor = nextCursor;
    if (!cursor) {
      result.done = true;
      break;
    }
  }

  result.nextCursor = cursor;
  log.info('Admin cleanup pass complete', {
    class: result.class,
    dryRun: result.dryRun,
    scanned: result.scanned,
    eligible: result.eligible,
    purged: result.purged,
    errorCount: result.errors.length,
    done: result.done,
    totalDatabaseSize: result.stats.totalDatabaseSize,
    totalMessageCount: result.stats.totalMessageCount,
    withData: result.stats.withData,
    empty: result.stats.empty,
    orphaned: result.stats.orphaned,
    caller: identity.isServiceToken
      ? `service-token:${identity.commonName ?? identity.sub}`
      : `user:${identity.email ?? identity.sub}`,
  });

  return Response.json(result);
}
