#!/usr/bin/env node
/**
 * Cleanup driver for orphaned/stale Durable Objects.
 *
 * Repeatedly POSTs /admin/cleanup-do, threading the cursor each call until the
 * worker reports `done: true`. Accumulates totals and prints a summary.
 *
 * The worker probes every DO it scans for staleness AND for storage stats
 * (database size, message/metadata counts and bytes, age distribution, top-N
 * largest). This driver merges those stats across batches and prints a final
 * breakdown so we can diagnose why a class's storage bill is larger than
 * expected without enumerating every DO client-side.
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
 *   --print-every <n>       Print a full histogram + top-N snapshot every N
 *                           batches (default 10). 0 disables interim prints.
 *                           Ctrl+C also prints the current snapshot before exit.
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
  else if (a === '--print-every') flags.printEvery = Number(args[++i]);
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
const printEvery = flags.printEvery ?? 10;

// Bucket labels mirror the bounds in src/adminCleanup.ts. The arrays returned
// by the worker have one slot per bucket; we just print them in order.
const SIZE_BUCKET_LABELS = ['empty', '<1 KB', '1-10 KB', '10-100 KB', '100K-1MB', '1-10 MB', '>=10 MB'];
const MESSAGE_COUNT_BUCKET_LABELS = ['0', '1-10', '11-100', '101-1k', '1k-10k', '>10k'];
const AGE_BUCKET_LABELS = ['no-activity', '<1 d', '1-7 d', '7-30 d', '30-90 d', '90-365 d', '>=1 yr'];
const DRIFT_BUCKET_LABELS = ['no msgs', '<1 d', '1-7 d', '7-30 d', '30-90 d', '>=90 d'];

const TOP_LARGEST_LIMIT = 25;

const totals = { scanned: 0, eligible: 0, purged: 0, errors: 0, batches: 0 };
const aggStats = {
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
  sizeBuckets: new Array(SIZE_BUCKET_LABELS.length).fill(0),
  messageCountBuckets: new Array(MESSAGE_COUNT_BUCKET_LABELS.length).fill(0),
  ageBuckets: new Array(AGE_BUCKET_LABELS.length).fill(0),
  updatedVsMessageDriftBuckets: new Array(DRIFT_BUCKET_LABELS.length).fill(0),
  topLargest: [],
};
let cursor = null;
const startedAt = Date.now();

console.log(
  `Starting cleanup: class=${flags.class} dryRun=${flags.dryRun} batch=${limit}` +
  (maxAgeMs ? ` maxAgeDays=${flags.maxAgeDays}` : '') +
  (printEvery > 0 ? ` printEvery=${printEvery}` : ' interimPrints=off'),
);

// Ctrl+C: print the current snapshot before exit so an interrupted long run
// doesn't waste the accumulated stats. Second Ctrl+C terminates immediately.
let sigintHandled = false;
process.on('SIGINT', () => {
  if (sigintHandled) process.exit(130);
  sigintHandled = true;
  console.log('\n\n[SIGINT] printing snapshot of stats so far...');
  printStatsSummary(aggStats, totals.scanned);
  process.exit(130);
});

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
  mergeStats(aggStats, result.stats);

  const batchSize = result.stats?.totalDatabaseSize ?? 0;
  const batchEligibleBytes = result.stats?.eligibleBytes ?? 0;
  const batchPurgedBytes = result.stats?.purgedBytes ?? 0;
  const heaviest = aggStats.topLargest[0];
  process.stdout.write(
    `  batch ${totals.batches}: scanned=${result.scanned} ` +
    `elig=${result.eligible} (${formatBytes(batchEligibleBytes)}) ` +
    `purg=${result.purged} (${formatBytes(batchPurgedBytes)}) ` +
    `err=${result.errors.length} ` +
    `batch=${formatBytes(batchSize)} ` +
    `cum=${formatBytes(aggStats.totalDatabaseSize)} ` +
    `cumPurged=${formatBytes(aggStats.purgedBytes)} ` +
    (heaviest ? `peakDO=${formatBytes(heaviest.databaseSize)} ` : '') +
    `done=${result.done}\n`,
  );
  if (result.errors.length > 0) {
    for (const err of result.errors.slice(0, 5)) {
      console.error(`    error: ${err.id}: ${err.error}`);
    }
    if (result.errors.length > 5) {
      console.error(`    (${result.errors.length - 5} more)`);
    }
  }

  if (printEvery > 0 && totals.batches % printEvery === 0) {
    console.log(`\n--- snapshot after ${totals.batches} batches ---`);
    printStatsSummary(aggStats, totals.scanned);
    console.log('--- resuming ---\n');
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

printStatsSummary(aggStats, totals.scanned);

/**
 * Merge a worker batch's stats into the running aggregate. Histograms add
 * element-wise; top-largest is re-sorted across all entries we've seen and
 * truncated to TOP_LARGEST_LIMIT.
 */
function mergeStats(agg, batchStats) {
  if (!batchStats) return;
  agg.withData += batchStats.withData ?? 0;
  agg.empty += batchStats.empty ?? 0;
  agg.orphaned += batchStats.orphaned ?? 0;
  agg.totalDatabaseSize += batchStats.totalDatabaseSize ?? 0;
  agg.totalMessageCount += batchStats.totalMessageCount ?? 0;
  agg.totalMessageBytes += batchStats.totalMessageBytes ?? 0;
  agg.totalMetadataCount += batchStats.totalMetadataCount ?? 0;
  agg.totalMetadataBytes += batchStats.totalMetadataBytes ?? 0;
  agg.eligibleBytes += batchStats.eligibleBytes ?? 0;
  agg.purgedBytes += batchStats.purgedBytes ?? 0;
  addInto(agg.sizeBuckets, batchStats.sizeBuckets);
  addInto(agg.messageCountBuckets, batchStats.messageCountBuckets);
  addInto(agg.ageBuckets, batchStats.ageBuckets);
  addInto(agg.updatedVsMessageDriftBuckets, batchStats.updatedVsMessageDriftBuckets);

  if (Array.isArray(batchStats.topLargest)) {
    const merged = agg.topLargest.concat(batchStats.topLargest);
    merged.sort((a, b) => b.databaseSize - a.databaseSize);
    agg.topLargest = merged.slice(0, TOP_LARGEST_LIMIT);
  }
}

function addInto(target, source) {
  if (!Array.isArray(source)) return;
  for (let i = 0; i < source.length && i < target.length; i++) {
    target[i] += source[i] ?? 0;
  }
}

function printStatsSummary(stats, scanned) {
  console.log('\n=== Storage stats ===');
  console.log(`Total scanned     : ${stats.withData + stats.empty} DOs (${scanned} including no-storage)`);
  console.log(`With data         : ${stats.withData}`);
  console.log(`Empty (residual)  : ${stats.empty}`);
  console.log(`Orphaned          : ${stats.orphaned}  (no updated_at, likely never wrote metadata)`);

  const totalSize = stats.totalDatabaseSize;
  const payloadBytes = stats.totalMessageBytes + stats.totalMetadataBytes;
  const overhead = Math.max(0, totalSize - payloadBytes);
  const avgSize = stats.withData > 0 ? totalSize / stats.withData : 0;

  console.log('\n=== Aggregate bytes ===');
  console.log(`Total databaseSize: ${formatBytes(totalSize)}`);
  console.log(`  message payload : ${formatBytes(stats.totalMessageBytes)} (${pct(stats.totalMessageBytes, totalSize)})`);
  console.log(`  metadata payload: ${formatBytes(stats.totalMetadataBytes)} (${pct(stats.totalMetadataBytes, totalSize)})`);
  console.log(`  overhead        : ${formatBytes(overhead)} (${pct(overhead, totalSize)})  (indexes + page slack)`);
  console.log(`Avg/DO with data  : ${formatBytes(avgSize)}`);
  console.log(`Eligible bytes    : ${formatBytes(stats.eligibleBytes)} (${pct(stats.eligibleBytes, totalSize)} of total)`);
  console.log(`Purged bytes      : ${formatBytes(stats.purgedBytes)} (${pct(stats.purgedBytes, totalSize)} of total)`);

  console.log('\n=== Total counts ===');
  console.log(`Messages          : ${stats.totalMessageCount.toLocaleString()}`);
  console.log(`Metadata rows     : ${stats.totalMetadataCount.toLocaleString()}`);

  printHistogram('Size distribution', SIZE_BUCKET_LABELS, stats.sizeBuckets);
  printHistogram('Message count distribution', MESSAGE_COUNT_BUCKET_LABELS, stats.messageCountBuckets);
  printHistogram('Age distribution (since metadata updated_at)', AGE_BUCKET_LABELS, stats.ageBuckets);
  printHistogram(
    'updated_at vs newest message drift (server-bumped freshness vs real)',
    DRIFT_BUCKET_LABELS,
    stats.updatedVsMessageDriftBuckets,
  );

  if (stats.topLargest.length > 0) {
    console.log(`\n=== Top ${stats.topLargest.length} largest DOs ===`);
    console.log('  Rank  Size        Messages   updated_at  lastMsg     oldestMsg   ID');
    const now = Date.now();
    stats.topLargest.forEach((entry, i) => {
      const updatedAge = entry.updatedAt != null ? formatAge(now - entry.updatedAt) : 'never';
      const newestAge = entry.newestMessageAt != null ? formatAge(now - entry.newestMessageAt) : 'none';
      const oldestAge = entry.oldestMessageAt != null ? formatAge(now - entry.oldestMessageAt) : 'none';
      console.log(
        `  ${String(i + 1).padStart(4)}  ` +
        `${formatBytes(entry.databaseSize).padStart(10)}  ` +
        `${entry.messageCount.toLocaleString().padStart(9)}  ` +
        `${updatedAge.padStart(10)}  ` +
        `${newestAge.padStart(10)}  ` +
        `${oldestAge.padStart(10)}  ` +
        `${entry.id}`
      );
    });
  }
}

function printHistogram(title, labels, counts) {
  console.log(`\n=== ${title} ===`);
  const max = Math.max(1, ...counts);
  const barWidth = 40;
  const labelWidth = Math.max(...labels.map(l => l.length));
  for (let i = 0; i < labels.length; i++) {
    const count = counts[i] ?? 0;
    const bar = '#'.repeat(Math.round((count / max) * barWidth));
    console.log(`  ${labels[i].padEnd(labelWidth)}  ${String(count).padStart(7)}  ${bar}`);
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  let v = n;
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024;
    unit++;
  }
  return `${v.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function pct(part, total) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 365) return `${Math.round(d)} d`;
  return `${(d / 365).toFixed(1)} y`;
}
