/** Small request/response helpers for the wiki server; no framework. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LocalWikiError, type LocalWikiErrorCode } from '@nimbalyst/local-wiki';

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const STATUS_FOR_WIKI_ERROR: Record<LocalWikiErrorCode, number> = {
  'not-a-wiki': 404,
  'unsupported-format': 400,
  'not-found': 404,
  malformed: 422,
  invalid: 400,
  cycle: 400,
  trashed: 409,
  'not-trashed': 409,
  exists: 409,
  'not-a-table': 400,
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
  } else if (err instanceof LocalWikiError) {
    sendJson(res, STATUS_FOR_WIKI_ERROR[err.code] ?? 400, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: 'internal', message: (err as Error)?.message ?? String(err) } });
  }
}

/**
 * Reads a JSON body. Requiring `application/json` is also a CSRF guard: a
 * cross-site form cannot send that content type without a CORS preflight,
 * which this server never answers.
 */
export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported-media-type', 'Send the body as application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too-large', 'Request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'bad-json', 'Request body is not valid JSON');
  }
}

export { BASE_HEADERS };
