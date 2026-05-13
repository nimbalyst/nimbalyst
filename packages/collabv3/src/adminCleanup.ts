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
 *   { scanned, eligible, purged, errors[], nextCursor }
 *
 * Run repeatedly via the driver script (scripts/cleanup-orphan-dos.mjs) which
 * threads the cursor and accumulates totals across worker invocations.
 */

import type { Env } from './types';
import { createLogger } from './logger';
import { verifyAccessJwt } from './accessJwt';

const log = createLogger('adminCleanup');

const SUPPORTED_CLASSES = {
  PersonalSessionRoom: { binding: 'SESSION_ROOM', defaultMaxAgeMs: 30 * 24 * 60 * 60 * 1000 },
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

interface CleanupResult {
  class: SupportedClass;
  dryRun: boolean;
  scanned: number;
  eligible: number;
  purged: number;
  errors: Array<{ id: string; error: string }>;
  nextCursor: string | null;
  done: boolean;
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
  result: CleanupResult,
): Promise<void> {
  result.scanned++;
  if (!obj.hasStoredData) return;
  try {
    const id = namespace.idFromString(obj.id);
    const stub = namespace.get(id);
    const { updatedAt, hasData } = await probeStaleness(stub);

    const isOrphan = updatedAt === null;
    const isStale = updatedAt !== null && updatedAt < cutoff;
    const noData = !hasData;
    if (!(isOrphan || isStale || noData)) return;

    result.eligible++;
    if (!dryRun) {
      await purgeDO(stub);
      result.purged++;
    }
  } catch (err) {
    result.errors.push({
      id: obj.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

/**
 * Probe a DO for staleness via /internal/staleness.
 */
async function probeStaleness(
  stub: DurableObjectStub,
): Promise<{ updatedAt: number | null; hasData: boolean }> {
  const response = await stub.fetch(new Request('https://internal/internal/staleness'));
  if (!response.ok) {
    throw new Error(`staleness probe returned ${response.status}`);
  }
  return response.json<{ updatedAt: number | null; hasData: boolean }>();
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
  };

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
        chunk.map((obj) => processObject(obj, namespace, cutoff, dryRun, result)),
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
    caller: identity.isServiceToken
      ? `service-token:${identity.commonName ?? identity.sub}`
      : `user:${identity.email ?? identity.sub}`,
  });

  return Response.json(result);
}
