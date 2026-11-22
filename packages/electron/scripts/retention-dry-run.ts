/**
 * Read-only dry run of tool-output retention against a COPY of the database.
 *
 * Answers "what would the retention pass reclaim, and what does it leave?"
 * with a measured number before a retention change ships. It walks the same
 * candidate rows the scheduled pass walks, runs the same pure rewrite
 * (`tombstoneRawContent`), and sums the bytes. It writes nothing.
 *
 * It refuses the live database: other processes must never open that file
 * (see packages/electron/DATABASE.md). Point it at a rolling backup, which is
 * a complete copy:
 *
 *   cd packages/electron
 *   pnpm exec esbuild scripts/retention-dry-run.ts --bundle --platform=node --format=cjs \
 *     --external:better-sqlite3 --outfile=node_modules/.cache/retention-dry-run.cjs
 *   node node_modules/.cache/retention-dry-run.cjs \
 *     "$HOME/Library/Application Support/@nimbalyst/electron/sqlite-db.backups/nimbalyst.backup-previous.sqlite" [retentionDays]
 *
 * A 10 GB copy takes a few minutes. Keep the candidate query and the stop
 * rule in step with `CANDIDATE_SQL` in src/main/database/toolOutputRetentionPass.ts.
 */

import * as path from 'path';
import Database from 'better-sqlite3';

import { tombstoneRawContent } from '../../runtime/src/storage/toolOutputRetention';

const SOURCE_PREFIXES = ['claude-code', 'openai-codex', 'copilot-cli', 'grok-build', 'cursor-agent'];

function main(): void {
  const [file, daysArg] = process.argv.slice(2);
  if (!file) {
    console.error('usage: retention-dry-run.ts <path to a database COPY> [retentionDays=30]');
    process.exit(2);
  }
  const resolved = path.resolve(file);
  if (path.basename(path.dirname(resolved)) === 'sqlite-db') {
    console.error('Refusing to open the live database. Pass a file from sqlite-db.backups/ or another copy.');
    process.exit(2);
  }
  const retentionDays = daysArg ? Number(daysArg) : 30;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    console.error(`retentionDays must be a positive number, got ${daysArg}`);
    process.exit(2);
  }

  const db = new Database(resolved, { readonly: true, fileMustExist: true });
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = db
    .prepare(
      `SELECT m.id, m.source, m.content, m.created_at
       FROM ai_agent_messages m
       JOIN ai_sessions s ON s.id = m.session_id
       WHERE m.direction = 'output'
         AND m.message_kind IN ('tool', 'meta')
         AND (${SOURCE_PREFIXES.map(() => "m.source LIKE ? || '%'").join(' OR ')})
         AND s.status NOT IN ('running', 'waiting_for_input')
       ORDER BY m.id ASC`,
    )
    .iterate(...SOURCE_PREFIXES) as IterableIterator<{ id: number; source: string; content: string; created_at: string }>;

  const mb = (n: number) => Number((n / 1024 / 1024).toFixed(1));
  const bySource = new Map<string, { scanned: number; rewritten: number; saved: number; left: number }>();
  let scanned = 0;
  let rewritten = 0;
  let saved = 0;
  let left = 0;
  let lastId = 0;
  let stoppedAt: { id: number; createdAt: string } | null = null;

  for (const row of rows) {
    const futureDated = row.created_at > stamp;
    if (row.created_at >= cutoff && !futureDated) {
      stoppedAt = { id: row.id, createdAt: row.created_at };
      break;
    }
    lastId = row.id;
    scanned++;
    if (futureDated) continue;

    const bucket = bySource.get(row.source) ?? { scanned: 0, rewritten: 0, saved: 0, left: 0 };
    bySource.set(row.source, bucket);
    bucket.scanned++;

    const before = Buffer.byteLength(row.content);
    const out = tombstoneRawContent(row.content, row.source, stamp);
    if (out === null) {
      left += before;
      bucket.left += before;
      continue;
    }
    const after = Buffer.byteLength(out);
    rewritten++;
    saved += before - after;
    left += after;
    bucket.rewritten++;
    bucket.saved += before - after;
    bucket.left += after;
  }
  db.close();

  console.log(JSON.stringify({
    file: resolved,
    retentionDays,
    cutoff,
    scanned,
    rewritten,
    savedMB: mb(saved),
    leftInAgedCandidateRowsMB: mb(left),
    lastId,
    stoppedAt,
    bySource: Object.fromEntries(
      [...bySource.entries()]
        .sort((a, b) => b[1].saved - a[1].saved)
        .map(([source, v]) => [source, { scanned: v.scanned, rewritten: v.rewritten, savedMB: mb(v.saved), leftMB: mb(v.left) }]),
    ),
  }, null, 2));
}

main();
