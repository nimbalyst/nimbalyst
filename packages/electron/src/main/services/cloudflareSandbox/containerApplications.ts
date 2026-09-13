/**
 * The container application behind the sandbox Worker.
 *
 * `wrangler deploy` creates one per `containers` entry and names it
 * `<worker>-<class name>`. `wrangler delete` removes the Worker and leaves the
 * application in the account, still listed as ready with a live instance. The
 * first live delete showed exactly that, with the panel reporting nothing left.
 * So delete has to find and remove it separately, and nothing here trusts the
 * Worker delete to have done it.
 */

import { SandboxOperationError } from "./errors";
import { runWrangler } from "./wranglerCli";

export interface ContainerApplication {
  id: string;
  name: string;
}

/** Everything a container command needs to land in the right account. */
export interface ContainerCommandScope {
  /** Generated control config carrying the explicit `account_id`. */
  configPath: string;
  profileName: string;
  /** Verified profile directory, so remote auth resolves the right profile. */
  cwd: string;
}

/** Cloudflare application ids are UUIDs; nothing else may reach the CLI. */
const APPLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse `wrangler containers list --json`.
 *
 * Anything that is not a JSON array is an error, not an empty account: treating
 * unparseable output as "no applications" would let a delete clear the record
 * while the application is still there, which is the bug this module exists
 * to prevent.
 */
export function parseContainerApplications(
  stdout: string
): ContainerApplication[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new SandboxOperationError("unknown", "containers-list-parse");
  }
  if (!Array.isArray(parsed)) {
    throw new SandboxOperationError("unknown", "containers-list-shape");
  }
  const applications: ContainerApplication[] = [];
  for (const entry of parsed) {
    const record = entry as { id?: unknown; name?: unknown } | null;
    if (
      typeof record?.id === "string" &&
      APPLICATION_ID.test(record.id) &&
      typeof record.name === "string"
    ) {
      applications.push({ id: record.id, name: record.name });
    }
  }
  return applications;
}

/**
 * The applications Cloudflare named for this Worker. Matched on the
 * `<worker>-` prefix rather than the one class we ship today, so a future
 * second Durable Object class is cleaned up too. Worker names carry a hashed
 * suffix, so the prefix cannot collide with another installation's Worker.
 */
export function applicationsForWorker(
  applications: ContainerApplication[],
  workerName: string
): ContainerApplication[] {
  const prefix = `${workerName}-`;
  return applications.filter((app) => app.name.startsWith(prefix));
}

export async function listContainerApplications(
  scope: ContainerCommandScope
): Promise<ContainerApplication[]> {
  const { stdout } = await runWrangler(
    [
      "containers",
      "list",
      "--json",
      "--config",
      scope.configPath,
      "--profile",
      scope.profileName,
    ],
    { cwd: scope.cwd }
  );
  return parseContainerApplications(stdout);
}

export async function deleteContainerApplication(
  id: string,
  scope: ContainerCommandScope
): Promise<void> {
  if (!APPLICATION_ID.test(id)) {
    throw new SandboxOperationError("unknown", "containers-delete-bad-id");
  }
  await runWrangler(
    [
      "containers",
      "delete",
      id,
      "--config",
      scope.configPath,
      "--profile",
      scope.profileName,
    ],
    { cwd: scope.cwd, timeoutMs: 2 * 60_000 }
  );
}
