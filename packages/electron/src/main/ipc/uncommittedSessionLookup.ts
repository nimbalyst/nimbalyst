import { createHash } from 'crypto';

// Above this many uncommitted files the session list skips per-file session
// matching (#1936). A workspace with ~160K untracked files built ~321K bound
// strings per refresh and OOMed main; the old bind limit failed near 16K paths.
// 5,000 files (10,000 bound strings) stays well below both, and a real working
// set of agent edits is far smaller.
export const UNCOMMITTED_SESSION_MATCH_CAP = 5000;

const SESSION_FILES_CACHE_TTL_MS = 5000;

type QueryFn = (
    sql: string,
    params: unknown[]
) => Promise<{ rows: Array<{ session_id: string; file_path: string }> }>;

/**
 * Cache key for a file set without materializing one giant joined string.
 * Order-independent: sorts then streams the paths into a hash.
 */
function makeCacheKey(workspacePath: string, uncommittedFiles: Set<string>): string {
    const hash = createHash('sha1');
    for (const file of Array.from(uncommittedFiles).sort()) {
        hash.update(file);
        hash.update('\0');
    }
    return `${workspacePath}::${uncommittedFiles.size}::${hash.digest('hex')}`;
}

/**
 * Builds the (uncommitted-file -> most recent editing session) lookup used by
 * sessions:list, sessions:list-children and sessions:get-uncommitted-counts.
 *
 * The query is bounded to the uncommitted paths instead of scanning the whole
 * per-file edit history. Concurrent callers with the same file set share one
 * query, and results are cached briefly. Above UNCOMMITTED_SESSION_MATCH_CAP
 * the lookup returns an empty map without querying, so session rows show no
 * uncommitted-file counts in that workspace.
 */
export function createUncommittedSessionLookup(
    query: QueryFn,
    warn: (message: string) => void = console.warn
): {
    lookup: (workspacePath: string, uncommittedFiles: Set<string>) => Promise<Map<string, string>>;
    invalidate: (workspacePath: string) => void;
} {
    const cache = new Map<string, { fileToSession: Map<string, string>; timestamp: number }>();
    const inFlight = new Map<string, Promise<Map<string, string>>>();
    // Workspaces already warned about, so a refresh loop logs once rather than per call
    const overCapWarned = new Set<string>();

    const lookup = async (
        workspacePath: string,
        uncommittedFiles: Set<string>
    ): Promise<Map<string, string>> => {
        if (uncommittedFiles.size === 0) {
            return new Map();
        }

        if (uncommittedFiles.size > UNCOMMITTED_SESSION_MATCH_CAP) {
            if (!overCapWarned.has(workspacePath)) {
                overCapWarned.add(workspacePath);
                warn(
                    `[SessionHandlers] ${uncommittedFiles.size} uncommitted files in ${workspacePath} exceeds ` +
                    `${UNCOMMITTED_SESSION_MATCH_CAP}; skipping per-session uncommitted-file counts`
                );
            }
            return new Map();
        }
        overCapWarned.delete(workspacePath);

        const cacheKey = makeCacheKey(workspacePath, uncommittedFiles);

        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < SESSION_FILES_CACHE_TTL_MS) {
            return cached.fileToSession;
        }

        const pending = inFlight.get(cacheKey);
        if (pending) return pending;

        const queryPromise = (async () => {
            // session_files historically stored paths in two forms (relative for
            // older Edit/Write rows, absolute for Bash watcher and ApplyPatch).
            // Look up by both so legacy rows still match. New rows are normalized
            // by SessionFileTracker.
            const candidatePaths: string[] = [];
            for (const relativePath of uncommittedFiles) {
                candidatePaths.push(relativePath);
                candidatePaths.push(`${workspacePath}/${relativePath}`);
            }

            // Pick the most recent session per file_path. Rewritten from PG's
            // `SELECT DISTINCT ON (file_path) ... ORDER BY file_path, timestamp DESC`
            // to a window-function form that works under both PGLite and SQLite.
            const { rows } = await query(
                `SELECT session_id, file_path FROM (
                   SELECT session_id, file_path,
                          ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY timestamp DESC) AS rn
                   FROM session_files
                   WHERE workspace_id = $1
                     AND link_type = 'edited'
                     AND file_path = ANY($2::text[])
                 ) ranked WHERE rn = 1`,
                [workspacePath, candidatePaths]
            );

            const fileToSession = new Map<string, string>();
            rows.forEach(row => {
                fileToSession.set(row.file_path, row.session_id);
            });

            cache.set(cacheKey, { fileToSession, timestamp: Date.now() });
            return fileToSession;
        })();

        inFlight.set(cacheKey, queryPromise);
        try {
            return await queryPromise;
        } finally {
            inFlight.delete(cacheKey);
        }
    };

    const invalidate = (workspacePath: string): void => {
        const prefix = `${workspacePath}::`;
        for (const key of cache.keys()) {
            if (key.startsWith(prefix)) {
                cache.delete(key);
            }
        }
    };

    return { lookup, invalidate };
}
