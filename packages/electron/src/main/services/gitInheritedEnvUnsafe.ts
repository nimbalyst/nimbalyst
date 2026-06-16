import type { SimpleGitOptions } from 'simple-git';

/**
 * simple-git's block-unsafe-operations plugin treats ANY explicitly-supplied
 * environment as potentially attacker-controlled and refuses to spawn git when
 * that env contains otherwise-legitimate variables such as GIT_EDITOR,
 * GIT_PAGER, GIT_ASKPASS or GIT_SSH_COMMAND. (When git inherits process.env
 * implicitly — i.e. no `.env()` call — the scan does not run, which is why
 * normal commits work despite those vars being present.)
 *
 * When we deliberately pass the user's own login-shell environment so hooks run
 * like a real terminal (see getGitSubprocessEnv), we must opt back into allowing
 * those variables. The environment is the user's own trusted machine config —
 * identical to what `git` sees in their terminal — so enabling these flags
 * restores terminal-equivalent behavior rather than weakening a real boundary.
 */
export const GIT_INHERITED_ENV_UNSAFE: SimpleGitOptions['unsafe'] = {
  allowUnsafeAlias: true,
  allowUnsafeAskPass: true,
  allowUnsafeConfigPaths: true,
  allowUnsafeConfigEnvCount: true,
  allowUnsafeCredentialHelper: true,
  allowUnsafeEditor: true,
  allowUnsafeMergeDriver: true,
  allowUnsafePager: true,
  allowUnsafeProtocolOverride: true,
  allowUnsafePack: true,
  allowUnsafeSshCommand: true,
  allowUnsafeGitProxy: true,
  allowUnsafeHooksPath: true,
  allowUnsafeDiffExternal: true,
  allowUnsafeDiffTextConv: true,
  allowUnsafeFilter: true,
  allowUnsafeFsMonitor: true,
  allowUnsafeGpgProgram: true,
  allowUnsafeTemplateDir: true,
};
