#!/usr/bin/env node
/**
 * Cleanup driver for orphaned/stale Durable Objects.
 *
 * Repeatedly POSTs /admin/cleanup-do, threading the cursor each call until the
 * worker reports `done: true`. Accumulates totals and prints a summary.
 *
 * Required env vars:
 *   CF_ACCESS_CLIENT_ID      Access service-token client id for the
 *                            "Nimbalyst Sync Admin" application
 *   CF_ACCESS_CLIENT_SECRET  Access service-token client secret
 *   COLLAB_HOST              base URL, e.g. https://sync.nimbalyst.com (no trailing /)
 *
 * Cloudflare Access enforces auth at the edge before the worker runs, and the
 * worker independently verifies the Access JWT against its configured AUD.
 * Without a valid service token (or a valid IdP-issued JWT) the request is
 * rejected with 401, either by Access or by the worker's JWT check.
 *
 * Usage:
 *   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
 *     COLLAB_HOST=https://sync.nimbalyst.com \
 *     node scripts/cleanup-orphan-dos.mjs --class PersonalSessionRoom --dry-run
 *
 * Flags:
 *   --class <name>          Required. PersonalSessionRoom | PersonalIndexRoom |
 *                           PersonalProjectSyncRoom
 *   --dry-run               Default. Reports eligibility without purging.
 *   --execute               Disable dry run. Actually purges.
 *   --max-age-days <n>      Override the per-class default TTL.
 *   --batch <n>             DOs scanned per worker invocation (default 200).
 */

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--execute') flags.dryRun = false;
  else if (a === '--class') flags.class = args[++i];
  else if (a === '--max-age-days') flags.maxAgeDays = Number(args[++i]);
  else if (a === '--batch') flags.batch = Number(args[++i]);
  else {
    console.error(`Unknown flag: ${a}`);
    process.exit(2);
  }
}

if (!flags.class) {
  console.error('Missing --class');
  process.exit(2);
}
if (flags.dryRun === undefined) flags.dryRun = true;

const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
const host = process.env.COLLAB_HOST;
if (!accessClientId || !accessClientSecret) {
  console.error('Missing CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET env vars');
  console.error('Generate a service token in Zero Trust -> Access -> Service Auth');
  process.exit(2);
}
if (!host) {
  console.error('Missing COLLAB_HOST env var (e.g. https://sync.nimbalyst.com)');
  process.exit(2);
}

const endpoint = `${host}/admin/cleanup-do`;
const limit = flags.batch ?? 200;
const maxAgeMs = flags.maxAgeDays != null
  ? flags.maxAgeDays * 24 * 60 * 60 * 1000
  : undefined;

const totals = { scanned: 0, eligible: 0, purged: 0, errors: 0, batches: 0 };
let cursor = null;
const startedAt = Date.now();

console.log(
  `Starting cleanup: class=${flags.class} dryRun=${flags.dryRun} batch=${limit}` +
  (maxAgeMs ? ` maxAgeDays=${flags.maxAgeDays}` : ''),
);

while (true) {
  const body = {
    class: flags.class,
    dryRun: flags.dryRun,
    limit,
    cursor,
  };
  if (maxAgeMs != null) body.maxAgeMs = maxAgeMs;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    // Don't auto-follow Access's redirect to the IdP login page; surface it as a 302
    // so we can give a useful error instead of parsing the IdP HTML as JSON.
    redirect: 'manual',
  });

  if (response.status === 301 || response.status === 302 || response.status === 307) {
    const location = response.headers.get('location') ?? '(no Location header)';
    console.error(
      `Cloudflare Access redirected the request (${response.status} -> ${location}).`,
    );
    console.error(
      'This means Access did not accept the service token and is falling back to ' +
      'the IdP login flow. Most likely cause: the application policy that should ' +
      'authorize this service token has action "Allow" instead of "Service Auth". ' +
      'In Zero Trust -> Access -> Applications -> Nimbalyst Sync Admin -> Policies, ' +
      'the policy bound to the service token must use the "Service Auth" action.',
    );
    process.exit(1);
  }
  if (response.status === 401 || response.status === 403) {
    const text = await response.text();
    console.error(
      `Cloudflare Access rejected the request (${response.status}). ` +
      `Check CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET and that the service ` +
      `token is bound to the "Nimbalyst Sync Admin" application policy.`,
    );
    console.error(text);
    process.exit(1);
  }
  if (!response.ok) {
    const text = await response.text();
    console.error(`Worker returned ${response.status}: ${text}`);
    process.exit(1);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    console.error(
      `Expected JSON response but got content-type "${contentType}". ` +
      `This usually means an Access/edge layer intercepted the request.`,
    );
    console.error(text.slice(0, 500));
    process.exit(1);
  }
  const result = await response.json();
  totals.scanned += result.scanned;
  totals.eligible += result.eligible;
  totals.purged += result.purged;
  totals.errors += result.errors.length;
  totals.batches += 1;

  process.stdout.write(
    `  batch ${totals.batches}: scanned=${result.scanned} ` +
    `eligible=${result.eligible} purged=${result.purged} ` +
    `errors=${result.errors.length} done=${result.done}\n`,
  );
  if (result.errors.length > 0) {
    for (const err of result.errors.slice(0, 5)) {
      console.error(`    error: ${err.id}: ${err.error}`);
    }
    if (result.errors.length > 5) {
      console.error(`    (${result.errors.length - 5} more)`);
    }
  }

  if (result.done) break;
  cursor = result.nextCursor;
  if (!cursor) break;
}

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\nDone in ${elapsedSec}s. ` +
  `scanned=${totals.scanned} eligible=${totals.eligible} ` +
  `purged=${totals.purged} errors=${totals.errors} batches=${totals.batches}`,
);
if (flags.dryRun) {
  console.log('Dry run -- nothing was deleted. Re-run with --execute to actually purge.');
}
