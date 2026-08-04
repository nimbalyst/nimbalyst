/**
 * Build the error raised when personal-sync cannot produce a usable JWT.
 *
 * Why this exists: "we could not reach the collab server" and "the server
 * rejected our session" are completely different operational problems, and the
 * old code reported both as `Personal JWT is expired (exp=...) and refresh did
 * not produce a fresh one`. That message names the token as the culprit, so an
 * unreachable sync worker -- e.g. `sessionSync.environment = 'development'`
 * while nothing is listening on localhost:8790 -- reads in main.log as a
 * recurring auth/refresh bug. Two separate investigations chased a JWT defect
 * that was never there.
 *
 * `isNetworkError` is already tagged at the fetch boundary in
 * StytchAuthService; this keeps that distinction alive all the way to the log
 * line. Neither case clears credentials -- the session is preserved and the
 * caller's reconnect-with-backoff recovers once the server is reachable again.
 */

export type PersonalRefreshFailureReason = 'network' | 'auth' | 'no-session';

// ---------------------------------------------------------------------------
// Transport-failure classification
// ---------------------------------------------------------------------------

/**
 * Why this is not just `error.isNetworkError`: only ONE call site tags that
 * flag (the `net.fetch` wrapper around `/auth/refresh` in StytchAuthService).
 * Every other fetch in the refresh chain -- notably the personal-org
 * `/api/teams/{orgId}/switch` exchange -- rejects with a RAW transport error,
 * which the old `isNetworkError` check read as false and therefore reported as
 * `auth`. That is the same misclassification this module exists to prevent,
 * just on a different branch, so the predicate has to recognise the errors
 * themselves rather than trusting an upstream tag.
 *
 * Shapes we have to cover:
 *  - Electron `net.fetch`   -> `TypeError: net::ERR_CONNECTION_REFUSED`
 *  - Node/undici `fetch`    -> `TypeError: fetch failed` with `cause.code`
 *  - abort / request timeout-> `AbortError` / `TimeoutError` / `ETIMEDOUT`
 *  - socket dies mid-reply  -> `ECONNRESET` / 'socket hang up' / 'terminated'
 *
 * The inverse mistake is worse than the one this module was written for.
 * Reporting a transport failure as auth produces a misleading log line; reading
 * a real 401 as transport makes the app retry forever and never tell the user
 * to re-authenticate. So the predicate is ordered, not a flat OR over the
 * cause chain: authoritative HTTP status evidence is looked for FIRST and wins
 * outright, and generic wrapper text (`fetch failed`, `network error`) only
 * counts when some link in the chain also carries real transport evidence.
 */
const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'EPIPE',
  'EPROTO',
  'ABORT_ERR',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const TRANSPORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AbortError',
  'TimeoutError',
  'ConnectTimeoutError',
  'SocketError',
  'HeadersTimeoutError',
]);

/**
 * Messages that identify the transport layer on their own: a Chromium net
 * error, or an errno spelled out in the text. A server that answered with a
 * status code never produces these.
 */
const HARD_TRANSPORT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /net::ERR_/i,                                   // Electron net.fetch
  /\bECONN(REFUSED|RESET|ABORTED)\b/i,
  /\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo/i,     // DNS
  /\bETIMEDOUT\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bENETDOWN\b|\bEPIPE\b/i,
  /socket hang up|other side closed|premature close/i,
];

/**
 * Weaker transport tells: real, but describable by a wrapper that is itself
 * sitting on top of a server rejection (our own `AbortSignal.timeout` around a
 * request the server did answer, for instance). Accepted only after the auth
 * checks below have had their say.
 */
const SOFT_TRANSPORT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /operation was aborted|request aborted/i,
  /\btimed? ?out\b/i,
  /connection closed|\bterminated\b/i,
];

/**
 * Deliberately NOT classified as transport on their own:
 *  - `fetch failed`  -- undici's generic wrapper; the real reason is nested in
 *                       `cause`, so the wrapper text proves nothing by itself.
 *  - `network error` -- our own tag text, which a message like
 *                       `HTTP 401 Unauthorized: network error while reading the
 *                       body` also matches.
 * Both need a corroborating `code` / `net::ERR_*` somewhere in the chain. This
 * is the corroboration rule that keeps a 401 wearing transport's clothes from
 * being retried forever.
 */

/** HTTP statuses that mean the server answered and refused our credentials. */
const AUTH_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/** Keys that carry an authoritative HTTP status on an error we may be handed. */
const HTTP_STATUS_KEYS = ['status', 'statusCode', 'status_code'] as const;

/**
 * Text that only a server-side rejection produces. Every pattern requires a
 * word, never a bare number, so `connect ECONNREFUSED 127.0.0.1:8403` cannot
 * trip it.
 */
const AUTH_MESSAGE_PATTERNS: readonly RegExp[] = [
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bhttp\s*\/?\s*(?:\d\.\d\s+)?40[13]\b/i,
  /\binvalid[ _-]?(?:session|token|jwt|credential)/i,
  /\bsession[ _-]?(?:expired|revoked|not[ _-]?found)\b/i,
];

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function coerceHttpStatus(value: unknown): number | null {
  const status = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{3}$/.test(value)
      ? Number(value)
      : null;
  return status !== null && status >= 100 && status <= 599 ? status : null;
}

/** Every HTTP status this link claims, including one nested on `response`. */
function readHttpStatuses(link: Record<string, unknown>): number[] {
  const statuses: number[] = [];
  for (const key of HTTP_STATUS_KEYS) {
    const status = coerceHttpStatus(link[key]);
    if (status !== null) statuses.push(status);
  }
  if (isObjectLike(link.response)) {
    for (const key of HTTP_STATUS_KEYS) {
      const status = coerceHttpStatus(link.response[key]);
      if (status !== null) statuses.push(status);
    }
  }
  return statuses;
}

function messageOf(link: Record<string, unknown>): string | null {
  return typeof link.message === 'string' && link.message ? link.message : null;
}

/** An HTTP 401/403 anywhere in the chain: the server answered and said no. */
function hasAuthStatusEvidence(link: Record<string, unknown>): boolean {
  return readHttpStatuses(link).some((status) => AUTH_HTTP_STATUSES.has(status));
}

/** An errno or Chromium net error: the request never reached an answer. */
function hasHardTransportEvidence(link: Record<string, unknown>): boolean {
  if (typeof link.code === 'string' && TRANSPORT_ERROR_CODES.has(link.code)) return true;
  const message = messageOf(link);
  return message !== null && HARD_TRANSPORT_MESSAGE_PATTERNS.some((p) => p.test(message));
}

function hasAuthMessageEvidence(link: Record<string, unknown>): boolean {
  const message = messageOf(link);
  return message !== null && AUTH_MESSAGE_PATTERNS.some((p) => p.test(message));
}

function hasSoftTransportEvidence(link: Record<string, unknown>): boolean {
  if (link.isNetworkError === true) return true;
  if (typeof link.name === 'string' && TRANSPORT_ERROR_NAMES.has(link.name)) return true;
  const message = messageOf(link);
  return message !== null && SOFT_TRANSPORT_MESSAGE_PATTERNS.some((p) => p.test(message));
}

/** Walk `cause` chains (undici nests the real error one or two levels down). */
function errorChain(error: unknown, depth = 5): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current && depth-- > 0) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * True when the request never got an answer from the server. A transport
 * failure must NEVER be reported or handled as a JWT/auth failure -- the stored
 * session is untouched and the correct response is to retry, not to re-auth.
 *
 * Ordered, and the order is the safety property:
 *  1. An authoritative HTTP 401/403 anywhere in the chain -> auth, full stop.
 *     A real rejection wrapped in our own timeout, or in undici's `fetch
 *     failed`, still has to surface as "re-authenticate", not as "retry".
 *  2. A real errno / `net::ERR_*` -> transport.
 *  3. Server-rejection wording with nothing from (2) to corroborate the
 *     transport reading -> auth.
 *  4. Only then the weaker transport tells (abort/timeout names, our own
 *     `isNetworkError` tag).
 * Generic wrapper text alone falls through to `false`.
 */
export function isTransportError(error: unknown): boolean {
  const chain = errorChain(error).filter(isObjectLike);
  if (chain.some(hasAuthStatusEvidence)) return false;
  if (chain.some(hasHardTransportEvidence)) return true;
  if (chain.some(hasAuthMessageEvidence)) return false;
  return chain.some(hasSoftTransportEvidence);
}

/**
 * A short, log-safe rendering of the transport failure -- the `code` when we
 * have one, otherwise the deepest message. This is what makes the log line
 * self-diagnosing: "unreachable" alone does not tell you whether nothing is
 * listening, DNS is broken, or the socket died mid-handshake.
 */
export function describeTransportError(error: unknown): string {
  const links = errorChain(error).filter((l): l is object => !!l && typeof l === 'object');
  for (const link of links) {
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string' && code) {
      const message = (link as { message?: unknown }).message;
      if (typeof message !== 'string' || !message) return code;
      // Keep the message when it already carries the code -- it is the part
      // that names the host:port, which is what identifies a client pointed at
      // a local dev collab server that is not running.
      return message.includes(code) ? message : `${code} (${message})`;
    }
  }
  for (const link of links.reverse()) {
    const message = (link as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'unknown transport error';
}

export interface PersonalJwtFailureInput {
  /** Why the last refresh attempt failed, or null if it was never classified. */
  reason: PersonalRefreshFailureReason | null;
  /** `exp` of the JWT we are stuck with, in ms since epoch, if decodable. */
  expiryMs: number | null;
  /** The collab server the refresh was attempted against. */
  serverUrl: string;
  /** Rendered transport error for the `network` case, when one was captured. */
  detail?: string | null;
}

export function describePersonalJwtFailure(input: PersonalJwtFailureInput): Error {
  const { reason, expiryMs, serverUrl, detail } = input;

  if (reason === 'network') {
    const cause = detail ? ` (${detail})` : '';
    const err = new Error(
      `[SyncManager] Sync server ${serverUrl} is unreachable${cause}, so the personal session could not be refreshed. ` +
        'The stored session is still valid and is NOT being cleared; sync will recover once the server is reachable.',
    );
    (err as { code?: string }).code = 'SYNC_SERVER_UNREACHABLE';
    return err;
  }

  const expiry = expiryMs !== null ? new Date(expiryMs).toISOString() : 'unknown';
  const err = new Error(
    `[SyncManager] Personal JWT is expired (exp=${expiry}) and refresh did not produce a fresh one`,
  );
  (err as { code?: string }).code = 'PERSONAL_JWT_EXPIRED';
  return err;
}
