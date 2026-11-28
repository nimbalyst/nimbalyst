/**
 * Entry of the git runner utility process (`out/main/gitRunner.js`), forked by
 * `gitRunnerService.ts`. Its static import closure must not include `electron`,
 * `electron-log`, `utils/logger` or `utils/store`; the build fails if it does.
 */
import { connectToParentPort } from '../../utilityProcess/childConnection';
import { startGitRunner } from './gitRunnerRuntime';

startGitRunner(connectToParentPort('GitRunner'));
