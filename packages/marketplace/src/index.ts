/**
 * Nimbalyst Extension Marketplace Worker
 *
 * Serves the extension registry and .nimext packages from R2,
 * with KV-based download counting.
 *
 * Routes:
 *   GET /registry              - Extension registry JSON
 *   GET /dl/:id/:version       - Download .nimext package
 *   GET /screenshots/:id/:file - Extension screenshot images
 *   GET /health                - Health check
 */

interface Env {
  EXTENSIONS_BUCKET: R2Bucket;
  DOWNLOAD_COUNTS: KVNamespace;
  VERSION: string;
  /** Public R2 bucket URL for direct file access (e.g. https://cdn.extensions.nimbalyst.com) */
  CDN_BASE_URL: string;
}

// CORS origins allowed to fetch from this Worker
const ALLOWED_ORIGINS = [
  'http://localhost:5273',
  'http://localhost:5274',
  'capacitor://localhost',
  'https://app.nimbalyst.com',
  'https://nimbalyst.com',
];

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('http://192.168.') ||
    origin.startsWith('http://10.');

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Only GET requests
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, request);
    }

    try {
      // GET /health
      if (pathname === '/health') {
        return jsonResponse(
          {
            status: 'ok',
            version: env.VERSION,
            timestamp: new Date().toISOString(),
          },
          200,
          request,
        );
      }

      // GET /registry
      if (pathname === '/registry') {
        return handleRegistry(request, env);
      }

      // GET /dl/:id/:version
      const dlMatch = pathname.match(/^\/dl\/([^/]+)\/([^/]+)$/);
      if (dlMatch) {
        const [, extensionId, version] = dlMatch;
        return handleDownload(request, env, extensionId, version);
      }

      // GET /screenshots/:id/:filename
      const ssMatch = pathname.match(/^\/screenshots\/([^/]+)\/(.+)$/);
      if (ssMatch) {
        const [, extensionId, filename] = ssMatch;
        return handleScreenshot(request, env, extensionId, filename);
      }

      return jsonResponse({ error: 'Not found' }, 404, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      console.error('Worker error:', message);
      return jsonResponse({ error: message }, 500, request);
    }
  },
};

/**
 * Serve registry.json from R2 with Cache API caching (5 min TTL).
 */
async function handleRegistry(request: Request, env: Env): Promise<Response> {
  // Try cache first
  const cache = caches.default;
  const cacheKey = new Request(new URL('/registry', request.url).toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // Fetch from R2
  const object = await env.EXTENSIONS_BUCKET.get('registry.json');
  if (!object) {
    return jsonResponse({ error: 'Registry not found' }, 404, request);
  }

  const body = await object.text();

  // Inject live download counts from KV
  const registry = JSON.parse(body);
  if (registry.extensions && Array.isArray(registry.extensions)) {
    const counts = await getDownloadCounts(env, registry.extensions.map((e: { id: string }) => e.id));
    for (const ext of registry.extensions) {
      if (counts[ext.id] !== undefined) {
        ext.downloads = counts[ext.id];
      }
    }
  }

  const response = new Response(JSON.stringify(registry), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders(request),
    },
  });

  // Store in Cache API (will respect Cache-Control TTL)
  await cache.put(cacheKey, response.clone());

  return response;
}

/**
 * Serve .nimext package directly from R2 and increment download count.
 */
async function handleDownload(
  request: Request,
  env: Env,
  extensionId: string,
  version: string,
): Promise<Response> {
  const key = `extensions/${extensionId}/${version}.nimext`;

  const object = await env.EXTENSIONS_BUCKET.get(key);
  if (!object) {
    return jsonResponse({ error: 'Extension not found' }, 404, request);
  }

  // Increment download count (fire-and-forget)
  incrementDownloadCount(env, extensionId).catch((err) => {
    console.error(`Failed to increment download count for ${extensionId}:`, err);
  });

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': object.size.toString(),
      'Cache-Control': 'public, max-age=86400',
      'Content-Disposition': `attachment; filename="${extensionId}-${version}.nimext"`,
      ...corsHeaders(request),
    },
  });
}

/**
 * Serve extension screenshot images directly from R2.
 */
async function handleScreenshot(
  request: Request,
  env: Env,
  extensionId: string,
  filename: string,
): Promise<Response> {
  // Sanitize filename to prevent path traversal
  const sanitized = filename.replace(/\.\./g, '').replace(/[^a-zA-Z0-9._-]/g, '');
  const key = `screenshots/${extensionId}/${sanitized}`;

  const object = await env.EXTENSIONS_BUCKET.get(key);
  if (!object) {
    return jsonResponse({ error: 'Screenshot not found' }, 404, request);
  }

  // Determine content type from filename
  let contentType = 'application/octet-stream';
  if (sanitized.endsWith('.png')) contentType = 'image/png';
  else if (sanitized.endsWith('.jpg') || sanitized.endsWith('.jpeg')) contentType = 'image/jpeg';
  else if (sanitized.endsWith('.webp')) contentType = 'image/webp';

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      ...corsHeaders(request),
    },
  });
}

/**
 * Increment the download count for an extension in KV.
 * Uses a simple get-increment-put pattern. KV is eventually consistent,
 * which is fine for download counts.
 */
async function incrementDownloadCount(env: Env, extensionId: string): Promise<void> {
  const key = `downloads:${extensionId}`;
  const current = await env.DOWNLOAD_COUNTS.get(key);
  const count = current ? parseInt(current, 10) : 0;
  await env.DOWNLOAD_COUNTS.put(key, (count + 1).toString());
}

/**
 * Get download counts for multiple extensions from KV.
 */
async function getDownloadCounts(
  env: Env,
  extensionIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // KV doesn't support batch gets, so we fetch in parallel
  const results = await Promise.all(
    extensionIds.map(async (id) => {
      const value = await env.DOWNLOAD_COUNTS.get(`downloads:${id}`);
      return { id, count: value ? parseInt(value, 10) : 0 };
    }),
  );

  for (const { id, count } of results) {
    counts[id] = count;
  }

  return counts;
}
