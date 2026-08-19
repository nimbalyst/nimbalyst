/**
 * The local-key vocabulary now lives in the runtime package, because the
 * tracker grid needs it too and the renderer's columns cannot reach into
 * electron's shared folder. Re-exported here so main-process callers keep their
 * import path.
 */

export {
  LOCAL_ISSUE_KEY_PREFIX,
  LOCAL_KEY_SEPARATOR,
  describeIssueKey,
  formatLocalIssueKey,
  formatLocalKey,
  isLocalIssueKey,
  isLocalKeyReference,
  isPrivateIssueReference,
  parseLocalIssueNumber,
  parseLocalKey,
  resolveDisplayIssueKey,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/localIssueKey';
