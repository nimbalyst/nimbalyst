/**
 * Git exports repository-local variables to hooks. Those variables override a
 * subprocess cwd, so forwarding them to a Git command for another workspace can
 * mutate the hook's repository instead of the requested one.
 *
 * Keep user-facing behavior variables such as PATH, GIT_SSH_COMMAND,
 * GIT_ASKPASS, and GIT_EDITOR. Remove only variables that can redirect repository
 * discovery, refs, objects, config, the work tree, or the index.
 */
const GIT_REPOSITORY_ENV_KEYS = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);

export function sanitizeGitRepositoryEnv(
  source: Record<string, string | undefined>
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const isIndexedConfigEntry = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key);
    if (
      value !== undefined &&
      !GIT_REPOSITORY_ENV_KEYS.has(key) &&
      !isIndexedConfigEntry
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
