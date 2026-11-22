/**
 * Environment flags under which this process must send no analytics at all,
 * whatever the user's setting says.
 *
 * E2E runs wipe `userData` before every launch, so each launch mints a new
 * `analyticsId` and reports `user_created`, `onboarding_completed` and so on as
 * a brand-new install. The previous guard checked `PLAYWRIGHT_TEST`, which
 * nothing sets; `buildTestEnv` sets `PLAYWRIGHT=1` and, because the
 * session-restore specs delete that, also `NIMBALYST_DISABLE_ANALYTICS=1`.
 */
export function isAnalyticsSuppressedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NIMBALYST_DISABLE_ANALYTICS === '1'
    || env.PLAYWRIGHT === '1'
    || !!env.PLAYWRIGHT_TEST;
}
