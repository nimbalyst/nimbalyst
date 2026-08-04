import path from 'path';
import { existsSync } from 'fs';
import { GIT_INHERITED_ENV_UNSAFE } from '../services/gitInheritedEnvUnsafe';

// ============================================================
// Git Status Cache
// Caches uncommitted file sets to avoid repeated git status calls
// when multiple components request session lists simultaneously.
// In-flight dedup so concurrent callers share one git status invocation.
// ============================================================
interface GitStatusCache {
    uncommittedFiles: Set<string>;
    timestamp: number;
}

const gitStatusCache = new Map<string, GitStatusCache>();
const gitStatusInFlight = new Map<string, Promise<Set<string>>>();
const GIT_STATUS_CACHE_TTL_MS = 5000; // 5 second cache

// Hard cap on `git status` so a hung git subprocess can never freeze the
// session list. On Windows a stale `.git/index.lock`, a credential-helper
// prompt, or antivirus scanning can leave `git status` hanging forever; the
// un-timed await pinned `sessionListLoadingAtom` true and the session-history
// panel showed a spinner that only an app restart cleared (issue #929).
const GIT_STATUS_TIMEOUT_MS = 8000;

/**
 * Reject with `message` if `promise` has not settled within `ms`. The
 * original promise is left with a no-op catch so a late rejection (e.g. the
 * git child being killed after the race is lost) does not surface as an
 * unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    promise.catch(() => {});
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * Returns the set of uncommitted file paths for a workspace, cached for a few
 * seconds and de-duplicated across concurrent callers. The underlying
 * `git status` is bounded by {@link GIT_STATUS_TIMEOUT_MS}: a hung git
 * subprocess rejects instead of hanging, so callers (e.g. the `sessions:list`
 * IPC) can degrade to zero uncommitted counts rather than freezing forever.
 *
 * Avoids spawning git status multiple times in rapid succession.
 */
export async function getCachedUncommittedFiles(workspacePath: string): Promise<Set<string>> {
    // Non-git workspaces have no uncommitted files
    if (!existsSync(path.join(workspacePath, '.git'))) {
        return new Set();
    }

    const cached = gitStatusCache.get(workspacePath);
    if (cached && Date.now() - cached.timestamp < GIT_STATUS_CACHE_TTL_MS) {
        return cached.uncommittedFiles;
    }

    const inFlight = gitStatusInFlight.get(workspacePath);
    if (inFlight) return inFlight;

    const queryPromise = (async () => {
        const simpleGit = (await import('simple-git')).default;
        // `timeout.block` aborts (and kills) the git child after N ms without
        // output, so a hung `git status` rejects instead of hanging. The
        // explicit withTimeout race is belt-and-suspenders in case the child
        // streams output but never exits.
        // GIT_OPTIONAL_LOCKS=0 is the environment equivalent of the
        // `--no-optional-locks` flag simple-git gives no way to pass. It keeps
        // this read-only status from refreshing (and so locking) `.git/index`,
        // where it would contend with concurrent git writers such as the commit
        // path (NIM-2285). The unsafe flags are required because supplying ANY
        // env makes simple-git scan it and refuse to spawn git when the user's
        // own environment contains GIT_EDITOR, GIT_PAGER and friends.
        const git = simpleGit(workspacePath, {
            timeout: { block: GIT_STATUS_TIMEOUT_MS },
            unsafe: GIT_INHERITED_ENV_UNSAFE,
        }).env({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });
        const status = await withTimeout(
            git.status(),
            GIT_STATUS_TIMEOUT_MS,
            `git status timed out after ${GIT_STATUS_TIMEOUT_MS}ms for ${workspacePath}`,
        );

        const uncommittedFiles = new Set([
            ...status.modified,
            ...status.created,
            ...status.not_added,
            ...status.deleted,
            ...status.renamed.map(r => r.to),
            ...status.staged
        ]);

        gitStatusCache.set(workspacePath, {
            uncommittedFiles,
            timestamp: Date.now()
        });

        return uncommittedFiles;
    })();

    gitStatusInFlight.set(workspacePath, queryPromise);
    try {
        return await queryPromise;
    } finally {
        gitStatusInFlight.delete(workspacePath);
    }
}
