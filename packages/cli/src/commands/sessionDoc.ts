/**
 * Read-only `nim session` and `nim doc` scaffolding (v1).
 *
 * These make the umbrella shape real without committing to write semantics yet.
 * Sessions read directly from the SQLite `ai_sessions` table (WAL-safe even when
 * the app is running). Documents are listed from the workspace filesystem, since
 * Nimbalyst documents are files on disk (there is no `documents` DB table).
 *
 * Write access to sessions/documents is an explicit non-goal of v1.
 */
import * as fs from 'fs';
import * as path from 'path';
import { openDatabase } from '../db/openDatabase.js';
import type { ParsedArgs } from '../cli/parse.js';
import { flagStr, flagBool, flagInt } from '../cli/parse.js';
import { usageError, notFoundError, connectionError } from '../cli/exitCodes.js';
import { resolveSqlitePath } from '../config/paths.js';
import { selectGateway } from '../gateway/select.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { bold, dim, gray } from '../cli/colors.js';
import { relativeFromNow } from '../cli/time.js';

// ---- session ---------------------------------------------------------------

export async function runSession(args: ParsedArgs): Promise<number> {
  const verb = args.verb ?? 'list';
  const dbPath = flagStr(args, 'db') ?? resolveSqlitePath();
  if (!fs.existsSync(dbPath)) {
    throw connectionError(`No Nimbalyst database at ${dbPath}.`);
  }
  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = true');
  try {
    if (verb === 'list') {
      const limit = flagBool(args, 'all') ? 1000 : flagInt(args, 'limit') ?? 30;
      const rows = db
        .prepare(
          `SELECT id, title, provider, model, status, mode, is_archived, last_activity, updated_at
           FROM ai_sessions
           WHERE is_archived = 0
           ORDER BY last_activity DESC LIMIT ?`,
        )
        .all(limit) as any[];

      if (flagBool(args, 'json')) {
        process.stdout.write(JSON.stringify({ sessions: rows, count: rows.length }, null, 2) + '\n');
        return 0;
      }
      if (flagBool(args, 'quiet')) {
        process.stdout.write(rows.map((r) => r.id).join('\n') + '\n');
        return 0;
      }
      if (rows.length === 0) {
        process.stdout.write(dim('No sessions.') + '\n');
        return 0;
      }
      const lines = rows.map(
        (r) =>
          `${dim(String(r.id).slice(0, 8))}  ${bold(r.title ?? '')}  ${gray(r.provider ?? '')}  ${gray(relativeFromNow(r.last_activity ?? r.updated_at))}`,
      );
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }

    if (verb === 'get' || verb === 'show') {
      const id = args.positionals[0];
      if (!id) throw usageError(`'nim session ${verb}' requires a session id.`);
      const row = db
        .prepare(`SELECT * FROM ai_sessions WHERE id = ? OR id LIKE ? LIMIT 1`)
        .get(id, `${id}%`) as any;
      if (!row) throw notFoundError(`No session found for '${id}'.`);
      if (flagBool(args, 'json')) {
        process.stdout.write(JSON.stringify(row, null, 2) + '\n');
        return 0;
      }
      const lines = [
        `${bold(row.id)}`,
        `${bold('Title')}    ${row.title ?? ''}`,
        `${bold('Provider')} ${row.provider ?? ''}${row.model ? ` (${row.model})` : ''}`,
        `${bold('Status')}   ${row.status ?? ''}`,
        `${bold('Mode')}     ${row.mode ?? ''}`,
        `${bold('Updated')}  ${row.updated_at ?? ''} ${dim(`(${relativeFromNow(row.updated_at)})`)}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
      return 0;
    }

    throw usageError(`Unknown session command '${verb}'. Try: list, get.`);
  } finally {
    db.close();
  }
}

// ---- doc -------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.nimbalyst', 'dist', 'build', '.build', 'out', 'coverage']);

export async function runDoc(args: ParsedArgs): Promise<number> {
  const verb = args.verb ?? 'list';

  // Resolve a workspace using the same precedence as tracker commands.
  const gateway = selectGateway({
    live: flagBool(args, 'live'),
    offline: flagBool(args, 'offline'),
    db: flagStr(args, 'db'),
  });
  let workspace: string;
  try {
    workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
  } finally {
    gateway.close();
  }

  if (verb === 'list') {
    const limit = flagBool(args, 'all') ? Number.MAX_SAFE_INTEGER : flagInt(args, 'limit') ?? 200;
    const files = listMarkdown(workspace, limit);
    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify({ workspace, documents: files }, null, 2) + '\n');
      return 0;
    }
    if (flagBool(args, 'quiet')) {
      process.stdout.write(files.map((f) => f.path).join('\n') + '\n');
      return 0;
    }
    if (files.length === 0) {
      process.stdout.write(dim('No markdown documents found.') + '\n');
      return 0;
    }
    const lines = files.map((f) => `${f.rel}  ${gray(relativeFromNow(f.modified))}`);
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  }

  if (verb === 'get' || verb === 'show' || verb === 'export') {
    const rel = args.positionals[0];
    if (!rel) throw usageError(`'nim doc ${verb}' requires a document path.`);
    const abs = path.resolve(workspace, rel);
    if (!abs.startsWith(path.resolve(workspace))) throw usageError('Document path escapes the workspace.');
    if (!fs.existsSync(abs)) throw notFoundError(`No document at '${rel}'.`);
    const content = fs.readFileSync(abs, 'utf8');
    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify({ path: abs, content }, null, 2) + '\n');
      return 0;
    }
    process.stdout.write(content + (content.endsWith('\n') ? '' : '\n'));
    return 0;
  }

  throw usageError(`Unknown doc command '${verb}'. Try: list, get.`);
}

interface DocFile {
  path: string;
  rel: string;
  modified: string;
}

function listMarkdown(root: string, limit: number): DocFile[] {
  const out: DocFile[] = [];
  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        const abs = path.join(dir, entry.name);
        let modified = '';
        try {
          modified = fs.statSync(abs).mtime.toISOString();
        } catch {
          /* ignore */
        }
        out.push({ path: abs, rel: path.relative(root, abs), modified });
      }
    }
  };
  walk(root);
  out.sort((a, b) => (b.modified > a.modified ? 1 : -1));
  return out.slice(0, limit);
}
