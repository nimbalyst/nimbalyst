/**
 * Tool policy constants for Claude Code provider.
 *
 * Keeping these lists centralized avoids burying policy data inside
 * large control-flow methods.
 *
 * Note: Planning mode tool restrictions are handled natively by the SDK
 * via `permissionMode: 'plan'`. No manual tool filtering is needed.
 */

// Internal Nimbalyst MCP tools that are auto-allowed (no permission prompt):
// they are display-only or confirm within their own widget, and the SDK's
// canUseTool path otherwise falls through to a dialog handler that has no UI for
// nimbalyst-owned tools — the Promise never resolves and the SDK surfaces "user
// cancelled MCP tool call" (issue #236, the kanban board appearing broken).
// Tool names follow the consolidated topology (mcp__<server>__<tool>).
export const INTERNAL_MCP_TOOLS: readonly string[] = [
  // Eager core (`nimbalyst`).
  'mcp__nimbalyst__update_session_meta',
  'mcp__nimbalyst__capture_editor_screenshot',
  'mcp__nimbalyst__display_to_user',
  'mcp__nimbalyst__get_session_edited_files',
  'mcp__nimbalyst__developer_git_commit_proposal',
  // git_log is served by the built-in Developer Tools extension, so it carries
  // the extension prefix (not core). Read-only → safe to auto-allow.
  'mcp__nimbalyst-developer__developer_git_log',
  // Situational (`nimbalyst-situational`) — voice.
  'mcp__nimbalyst-situational__voice_agent_speak',
  'mcp__nimbalyst-situational__voice_agent_stop',
  // Trackers (`nimbalyst-trackers`).
  'mcp__nimbalyst-trackers__tracker_list',
  'mcp__nimbalyst-trackers__tracker_get',
  'mcp__nimbalyst-trackers__tracker_list_types',
  'mcp__nimbalyst-trackers__tracker_create',
  'mcp__nimbalyst-trackers__tracker_update',
  'mcp__nimbalyst-trackers__tracker_link_session',
  'mcp__nimbalyst-trackers__tracker_unlink_session',
  'mcp__nimbalyst-trackers__tracker_link_file',
  'mcp__nimbalyst-trackers__tracker_add_comment',
  'mcp__nimbalyst-trackers__tracker_define_type',
  'mcp__nimbalyst-trackers__tracker_delete_type',
  // Host (`nimbalyst-host`) — session-context reads.
  'mcp__nimbalyst-host__get_session_summary',
  'mcp__nimbalyst-host__get_workstream_overview',
  'mcp__nimbalyst-host__list_recent_sessions',
  'mcp__nimbalyst-host__get_workstream_edited_files',
];

export const TEAM_TOOLS: readonly string[] = [
  'SendMessage',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
  'TeamCreate',
  'TeamDelete',
  'TeammateTool',
  'TodoRead',
  'TodoWrite',
];
