export interface BuildInfo {
    version: string;
    commitHash: string;
    buildDate: string;
    isOfficialBuild: boolean;
}

/**
 * Build-identity info for the About window (NIM-413). `commitHash` and
 * `buildDate` come from `process.env.BUILD_COMMIT_HASH` / `BUILD_DATE`,
 * baked in at build time by electron.vite.config.ts (see the comment there
 * for why: a packaged app doesn't ship its .git directory).
 *
 * `isOfficialBuild` reuses the existing `OFFICIAL_BUILD` env var, which the
 * official release CI (.github/workflows/electron-build.yml) sets to 'true'
 * and every other build (including local/dev/fork builds) leaves unset -
 * already the source of truth AnalyticsService uses to flag "dev users".
 */
export function getBuildInfo(appVersion: string): BuildInfo {
    return {
        version: appVersion,
        commitHash: process.env.BUILD_COMMIT_HASH || 'unknown',
        buildDate: process.env.BUILD_DATE || 'unknown',
        isOfficialBuild: process.env.OFFICIAL_BUILD === 'true',
    };
}
