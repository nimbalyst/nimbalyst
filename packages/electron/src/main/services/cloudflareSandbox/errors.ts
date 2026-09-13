/**
 * Turning Wrangler failures into something safe to render.
 *
 * Raw subprocess output never reaches the renderer AND never reaches the log.
 * Wrangler echoes an `Authorization` header or a token prefix on some failure
 * modes, and OAuth URLs carry codes in their query string; writing any of that
 * to `main.log` would persist a credential to disk on the user's machine, where
 * it long outlives the failure and gets pasted into bug reports.
 *
 * So raw text is used for exactly one thing — classification — and is then
 * dropped. What gets logged is the curated code plus a fixed event label that
 * this codebase authored. That is enough to know which step failed; it is not
 * enough to reconstruct a secret.
 */

import type {
  CloudflareSandboxError,
  CloudflareSandboxErrorCode,
} from "../../../shared/cloudflareSandbox";
import { logger } from "../../utils/logger";

/** Fixed, reviewable message per code. Never interpolates subprocess output. */
const MESSAGES: Record<CloudflareSandboxErrorCode, string> = {
  "wrangler-missing":
    "Wrangler was not found. Install the Cloudflare Wrangler CLI and make sure it is on your PATH.",
  "wrangler-unsupported":
    "This version of Wrangler does not support named auth profiles. Update Wrangler to 4.125.0 or newer.",
  "not-authenticated":
    "This Wrangler profile is not signed in. Sign in again to continue.",
  "profile-exists":
    "A Wrangler profile with that name already exists. Re-authenticate it instead of creating it again.",
  "login-cancelled": "Sign-in was cancelled before it completed.",
  "account-required":
    "Choose which Cloudflare account to use. Nimbalyst will not pick one for you.",
  "plan-stale":
    "This deployment plan is out of date. Review the plan again before deploying.",
  // Deliberately does NOT claim nothing was created. `wrangler deploy` is not
  // transactional: it uploads the Worker before it provisions the container
  // image, so a failure routinely leaves a real Worker in the user's account.
  // Telling them "no changes were saved" would send them looking for nothing
  // while a half-built deployment sits there billing them.
  "deploy-failed":
    "Wrangler could not finish the deployment. Some resources may already have been created in your Cloudflare account — Nimbalyst kept this sandbox listed so you can retry or delete it.",
  "deployment-stale":
    "This sandbox has changed since it was loaded. Reload it before continuing.",
  "worker-missing":
    "The Worker for this sandbox no longer exists in your Cloudflare account.",
  "confirmation-required":
    "This action needs an explicit confirmation before it can run.",
  "container-unavailable":
    "The sandbox is deployed, but its container could not be reached.",
  // The container's filesystem is ephemeral, so this is the ordinary state
  // after an idle sleep rather than a fault. The message says what to do.
  "node-not-provisioned":
    "This sandbox has no agent node in it. Connect the node again. The container discards its files whenever it sleeps.",
  "node-start-failed":
    "The agent node could not start in this sandbox. Check its recent output and try connecting again.",
  "grant-failed":
    "Nimbalyst could not authorize this sandbox with the sync server, so the node was not started.",
  unknown: "Something went wrong talking to Wrangler.",
};

/**
 * Patterns that identify a failure. Ordered: the first match wins, so put the
 * specific ones above the general ones.
 */
const CLASSIFIERS: ReadonlyArray<
  readonly [RegExp, CloudflareSandboxErrorCode]
> = [
  [
    /ENOENT|command not found|is not recognized as an internal/i,
    "wrangler-missing",
  ],
  [/unknown argument: profile|unknown command: auth/i, "wrangler-unsupported"],
  [/already exists/i, "profile-exists"],
  [
    /could not authenticate|not authenticated|not logged in|please run .?wrangler login|invalid_grant|token .*expired/i,
    "not-authenticated",
  ],
  [/cancell?ed|aborted by user|SIGINT/i, "login-cancelled"],
  [
    /could not find an account|multiple accounts|mandatory to specify an account ID|please set the appropriate [`'"]?account_id\b/i,
    "account-required",
  ],
  [/\bcode(?:["']?\s*:\s*|\s+)10000\b|authentication error/i, "not-authenticated"],
  // 10090 is what `wrangler delete` reports for a name with no Worker behind
  // it (seen live on the first delete retry). A retried delete needs to tell
  // this apart from a failure so it can finish removing the container.
  [
    /\bcode(?:["']?\s*:\s*|\s+)10090\b|this worker does not exist|service_not_found/i,
    "worker-missing",
  ],
];

/** Classify raw subprocess text. Exported for tests; never returns the text. */
export function classifyWranglerFailure(
  raw: string,
  fallback: CloudflareSandboxErrorCode = "unknown"
): CloudflareSandboxErrorCode {
  for (const [pattern, code] of CLASSIFIERS) {
    if (pattern.test(raw)) return code;
  }
  return fallback;
}

/**
 * Build a renderer-safe error.
 *
 * `event` is a short, fixed label written by this codebase naming the step that
 * failed, e.g. `'deploy'` or `'whoami'`. It is the only thing logged alongside
 * the code. Never pass subprocess output, a URL, or an exception message: those
 * can carry tokens, and this function is the last place that could stop them
 * reaching disk.
 *
 * `userMessage` overrides the table entry and is likewise only for text this
 * codebase authored, such as the artifact provider's `reason`.
 */
export function sandboxError(
  code: CloudflareSandboxErrorCode,
  event?: string,
  userMessage?: string
): CloudflareSandboxError {
  logger.main.warn(
    `[CloudflareSandbox] ${code}${event ? ` during ${event}` : ""}`
  );
  return { code, message: userMessage ?? MESSAGES[code] };
}

/**
 * Map an arbitrary thrown value to a safe error. Used at every handler
 * boundary so a stray exception cannot leak a stack trace into the UI.
 */
export function toSandboxError(
  error: unknown,
  fallback: CloudflareSandboxErrorCode = "unknown"
): CloudflareSandboxError {
  if (isSandboxErrorCarrier(error)) {
    return sandboxError(error.sandboxErrorCode, error.event, error.userMessage);
  }
  // `raw` is read to classify and then goes out of scope. It is never logged
  // and never returned; see the module comment.
  const raw = error instanceof Error ? `${error.message}` : String(error);
  return sandboxError(classifyWranglerFailure(raw, fallback));
}

/** Error subclass carrying a pre-decided code through the call stack. */
export class SandboxOperationError extends Error {
  readonly sandboxErrorCode: CloudflareSandboxErrorCode;
  /** Fixed step label, safe to log. See {@link sandboxError}. */
  readonly event?: string;
  /** Curated, renderer-safe override. See {@link sandboxError}. */
  readonly userMessage?: string;

  constructor(
    code: CloudflareSandboxErrorCode,
    event?: string,
    userMessage?: string
  ) {
    super(userMessage ?? MESSAGES[code]);
    this.name = "SandboxOperationError";
    this.sandboxErrorCode = code;
    this.event = event;
    this.userMessage = userMessage;
  }
}

function isSandboxErrorCarrier(value: unknown): value is {
  sandboxErrorCode: CloudflareSandboxErrorCode;
  event?: string;
  userMessage?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "sandboxErrorCode" in value &&
    typeof (value as { sandboxErrorCode: unknown }).sandboxErrorCode ===
      "string" &&
    (value as { sandboxErrorCode: string }).sandboxErrorCode in MESSAGES
  );
}
