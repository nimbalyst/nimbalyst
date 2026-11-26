/**
 * Electron wiring of the git runner: `index.ts` calls `configureGitRunner` when
 * the app is ready and `shutdownGitRunner` once quit is committed. Nothing else
 * imports this module, so the git call sites stay free of Electron.
 */
import { app, utilityProcess } from 'electron';
import { logger } from '../../utils/logger';
import { createGitRunner, GIT_RUNNER_KILL_SWITCH, isGitRunnerEnabled, type GitRunner } from './gitRunnerClient';
import { setGitRunTransport } from './runGit';

let runner: GitRunner | null = null;

/** Route `runGit` through the runner, which starts on the first call. */
export function configureGitRunner(env: NodeJS.ProcessEnv = process.env): void {
  if (runner) return;
  if (!isGitRunnerEnabled(env)) {
    logger.main.info(`[GitRunner] off (${GIT_RUNNER_KILL_SWITCH}=off): git runs in the main process`);
    return;
  }
  runner = createGitRunner({
    launch: (entryPath, options) => utilityProcess.fork(entryPath, [], options),
    isAppReady: () => app.isReady(),
    log: logger.main,
  });
  setGitRunTransport(runner.transport);
}

/** Kill the runner. Calls still pending finish in process; later calls run in process. */
export function shutdownGitRunner(): void {
  setGitRunTransport(null);
  runner?.stop();
  runner = null;
}
