# PostHog Events Reference

This document catalogs all PostHog analytics events tracked in Nimbalyst. **This document MUST be updated whenever PostHog events are added, modified, or removed.**

## Version Tracking

Each event table includes columns tracking when events were first added and when significant changes were made. This helps understand the data available in PostHog at different points in time.

### Column Definitions

| Column | Description |
| --- | --- |
| **First Added (Public)** | The first public release version where this event was included. Events added before v0.45.25 (the first public alpha) show v0.45.25. |
| **Significant Changes** | Notable modifications to how the event is tracked (new properties, behavior changes, bug fixes). Each entry should include the version and a brief description. |

### How to Fill In These Columns

When adding or modifying events:

1. **For new events being added:**
  - If the change is not yet released publicly, use: `(pending release as of <short-commit-hash>)`
  - Example: `(pending release as of abc1234)`
  - Once released, update to the actual public version: `v0.49.14`

2. **For modifications to existing events:**
  - Add an entry to the "Significant Changes" column
  - Format: `v0.X.Y: <brief description>`
  - Multiple changes should be separated by `<br/>`
  - Example: `v0.48.13: Added slashCommandName property<br/>v0.47.2: Added hasAttachments property`

3. **Determining the public release version:**
  - Check which public release contains your commit: `git tag --contains <commit-hash> --sort=version:refname | head -1`
  - https://github.com/Nimbalyst/nimbalyst/releases)Then verify if that version is a public release (check https://github.com/Nimbalyst/nimbalyst/releases)
  - If the internal version isn't publicly released yet, find the next public release that contains it

4. **Public release versions** (as of this writing):
  - v0.45.25 (2025-11-14) - First public alpha
  - v0.45.26 (2025-11-14)
  - v0.45.34 (2025-11-19)
  - v0.46.0 (2025-11-24)
  - v0.46.1 (2025-11-25)
  - v0.47.2 (2025-12-10)
  - v0.48.13 (2025-12-17)
  - v0.49.14 (2025-12-27)
  - Check https://github.com/Nimbalyst/nimbalyst/releases for the latest list

## Overview

Nimbalyst uses PostHog for anonymous usage analytics with two tracking contexts:
- **Main Process**: Server-side events via `AnalyticsService.getInstance().sendEvent()`
- **Renderer Process**: Client-side events via `usePostHog()` hook from posthog-js/react

All events include `$session_id` property automatically. Dev users are marked with `is_dev_user: true` via `$set_once`.

## Events Catalog

### File Operations

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `file_opened` | `FileHandlers.ts:85`<br/>`WorkspaceHandlers.ts:804` | User opens file via dialog or workspace tree | `source` (dialog/workspace)<br/>`fileType`<br/>`hasWorkspace` | v0.45.25 (2025-11-14) |  |
| `file_saved` | `FileHandlers.ts:199` | User manually saves file (Cmd+S) | `saveType` (manual)<br/>`fileType`<br/>`hasFrontmatter`<br/>`wordCount` | v0.45.25 (2025-11-14) |  |
| `file_save_failed` | `FileHandlers.ts:212, 277` | File save operation fails | `errorType`<br/>`fileType`<br/>`isAutoSave` | v0.45.25 (2025-11-14) |  |
| `file_created` | `FileHandlers.ts:399`<br/>`WorkspaceHandlers.ts:154` | User creates new file | `creationType` (new_file_menu/ai_tool)<br/>`fileType` (markdown/mockup/text/other) | v0.45.25 (2025-11-14) | v0.47.2 (2025-12-10): Added mockup fileType |
| `file_renamed` | `WorkspaceHandlers.ts:592` | User renames file in workspace | None | v0.45.25 (2025-11-14) |  |
| `file_deleted` | `WorkspaceHandlers.ts:618` | User deletes file from workspace | None | v0.45.25 (2025-11-14) |  |

### Workspace Operations

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `workspace_opened` | `SessionState.ts:122`<br/>`index.ts:406`<br/>`WorkspaceManagerWindow.ts:292` | Workspace opened from startup, CLI, or dialog | `fileCount` (1-10, 11-50, 51-100, 100+)<br/>`hasSubfolders`<br/>`source` (startup_restore/cli/dialog)<br/>`isGitRepository`<br/>`isGitHub` | v0.45.25 (2025-11-14) | (pending release): Added isGitRepository and isGitHub properties |
| `workspace_opened_with_filter` | `index.ts:433` | Workspace opened with git-worktree filter | `filter` (git-worktree)<br/>`$set_once: ever_opened_direct_to_worktree` | v0.45.25 (2025-11-14) |  |
| `workspace_file_tree_expanded` | `WorkspaceWatcher.ts:53` | File tree expands with new files detected | `depth`<br/>`fileCount` (0-10, 11-50, 51-100, 100+) | v0.45.25 (2025-11-14) |  |
| `workspace_search_used` | `QuickOpen.tsx:130, 230` | User searches workspace (files or content) | `resultCount` (0-4, 5-9, 10-49, 50-99, 100+)<br/>`queryLength` (1, 2-3, 4-9, 10+)<br/>`searchType` (file_name/content) | v0.45.25 (2025-11-14) |  |

### Git Worktree Operations

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `worktree_created` | `WorktreeHandlers.ts:115` | User creates a new git worktree | `duration_ms`<br/>`retry_count`<br/>`base_branch_source` (`default` \| `picker`) | (pending release) | (pending release): Added base_branch_source (#264) |
| `worktree_archived` | `WorktreeHandlers.ts:897` | User archives a worktree (sessions archived immediately, cleanup queued) | `session_count`<br/>`worktree_age_days`<br/>`failed_sessions`<br/>`has_uncommitted_changes`<br/>`has_unmerged_changes` | (pending release as of 6d0b51b5) | (pending release): Added has_uncommitted_changes and has_unmerged_changes |
| `worktree_archive_completed` | `WorktreeHandlers.ts:921` | Worktree cleanup completes successfully | `session_count`<br/>`duration_ms` | (pending release as of 6d0b51b5) |  |
| `worktree_archive_failed` | `WorktreeHandlers.ts:937, 961` | Worktree archive fails | `error_type`<br/>`stage` (archiving-sessions/removing-worktree) | (pending release as of 6d0b51b5) |  |
| `worktree_rebase_attempted` | `WorktreeHandlers.ts:804` | User initiates rebase of worktree from base branch | `success`<br/>`had_conflicts`<br/>`had_untracked_files_conflict` | (pending release) |  |
| `worktree_merge_attempted` | `WorktreeHandlers.ts:756` | User initiates merge of worktree to main branch | `success`<br/>`had_conflicts` | (pending release) |  |

### Theme Management

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `theme_changed` | `ApplicationMenu.ts:848, 877, 906, 937` | User selects theme from Window > Theme menu | `theme` (light/dark/crystal-dark/system) | v0.45.25 (2025-11-14) |  |

### Navigation & Editor Mode

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `content_mode_switched` | `NavigationGutter.tsx:111` | User switches between Files and Agent modes via navigation gutter | `fromMode` (files/agent/settings)<br/>`toMode` (files/agent/settings) | v0.48.13 (2025-12-17) |  |
| `editor_type_opened` | `TabEditor.tsx:242` | User opens a file in an editor tab | `editorCategory` (markdown/monaco/image or extension name like "Spreadsheet Editor", "PDF Viewer", "Excalidraw Editor", "Data Model Editor")<br/>`fileExtension` (e.g., .md, .csv, .prisma, .mockup.html)<br/>`hasMermaid` (boolean, for markdown)<br/>`hasDataModel` (boolean, for markdown) | v0.48.13 (2025-12-17) | (pending release): Renamed editorType to editorCategory; editorCategory now uses extension displayName for custom editors; fileExtension contains actual extension |
| `markdown_view_mode_switched` | `TabEditor.tsx:1556, 1606` | User switches between rich text (lexical) and raw markdown (monaco) view modes | `fromMode` (lexical/monaco)<br/>`toMode` (lexical/monaco) | v0.48.13 (2025-12-17) |  |
| `session_view_mode_switched` | `SessionHistory.tsx` | User switches between list and kanban views for session history | `fromMode` (list/card/kanban)<br/>`toMode` (list/card/kanban) | (pending release) |  |
| `session_list_filter_applied` | `SessionHistory.tsx` | User applies a tag filter or searches in the sessions list panel | `filterType` (tag/search)<br/>`activeTagCount` (number of active tag filters) | (pending release) |  |

### Session Kanban Board

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `kanban_card_phase_changed` | `SessionKanbanBoard.tsx` | Card moved between phase columns via drag-drop or Cmd+Arrow keyboard shortcut | `method` (drag/keyboard)<br/>`toPhase` (backlog/planning/implementing/validating/complete/unphased)<br/>`cardCount` (number of cards moved)<br/>`cardType` (session/workstream/worktree/mixed) | (pending release) |  |
| `kanban_card_opened` | `SessionKanbanBoard.tsx` | User opens a session from the kanban board (Enter key or double-click) | `cardType` (session/workstream/worktree) | (pending release) |  |
| `kanban_card_peeked` | `SessionKanbanBoard.tsx` | User toggles transcript peek on a kanban card (Space key or hover) | `action` (opened/closed) | (pending release) |  |
| `kanban_card_archived` | `SessionKanbanBoard.tsx` | User archives card(s) from the kanban board via drag to archive gutter or context menu | `cardCount` (number of cards archived)<br/>`cardType` (session/workstream/worktree/mixed) | (pending release) |  |
| `kanban_filter_applied` | `SessionKanbanBoard.tsx` | User applies a tag filter or searches on the kanban board | `filterType` (tag/search)<br/>`activeTagCount` (number of active tag filters) | (pending release) |  |
| `kanban_column_collapsed` | `SessionKanbanBoard.tsx` | User collapses or expands a kanban phase column | `action` (collapsed/expanded)<br/>`column` (backlog/planning/implementing/validating/complete) | (pending release) |  |

### File History

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `file_history_opened` | `HistoryDialog.tsx:103` | User opens the file history dialog (Cmd+Y) | `fileType` (markdown/code/image) | v0.48.13 (2025-12-17) |  |
| `file_history_restored` | `HistoryDialog.tsx:260` | User restores a previous version from history | `fileType` (markdown/code/image) | v0.48.13 (2025-12-17) |  |

### AI Chat & Sessions

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `create_ai_session` | `AIService.ts:1860`<br/>`SessionHandlers.ts:323, 672` | User creates new AI chat session | `provider`<br/>`is_worktree_session` (boolean)<br/>`is_workstream_child` (boolean)<br/>`is_meta_agent_session` (boolean) | v0.45.25 (2025-11-14) | v0.52.14: Added is_worktree_session and is_workstream_child properties<br/>(pending release): Also emitted from SessionHandlers so Files and Agent mode session creation paths are tracked<br/>(pending release): Added is_meta_agent_session property |
| `ai_message_sent` | `AIService.ts:1822` | User sends message in AI chat | `provider`<br/>`hasDocumentContext`<br/>`hasAttachments`<br/>`contentMode` (files/agent/unknown)<br/>`sessionMode` (optional, planning/agent)<br/>`fileExtension` (optional, when document open)<br/>`usedSlashCommand` (optional)<br/>`slashCommandName` (optional)<br/>`slashCommandPackageId` (optional) | v0.45.25 (2025-11-14) | v0.47.2 (2025-12-10): Added usedSlashCommand, slashCommandName, slashCommandPackageId properties<br/>(pending release as of 5698aa25): Added fileExtension property<br/>(pending release): Added sessionMode property |
| `ai_message_queued` | `AIService.ts:2517, 640` | User queues message while AI is busy processing | `provider`<br/>`source` (local/mobile)<br/>`hasDocumentContext`<br/>`hasAttachments`<br/>`fileExtension` (optional, local only when document open) | (pending release as of f891af91) | (pending release as of 5698aa25): Added fileExtension property |
| `ai_response_received` | `MessageStreamingHandler.ts:1913, 2477` | AI provider returns response | `provider`<br/>`responseType` (text/tool_use/error)<br/>`toolsUsed`<br/>`usedChartTool`<br/>`responseTime`<br/>`chunkCount` (0-9, 10-49, 50-99, 100+, success only)<br/>`totalLength` (0-99, 100-499, 500-999, 1000+, success only) | v0.45.25 (2025-11-14) | (pending release): Merged `ai_response_streamed` fields (`chunkCount`, `totalLength`) into this event to remove the 1:1 duplicate |
| `ai_stream_interrupted` | `AIService.ts:1024, 1483` | AI streaming stops prematurely | `provider`<br/>`chunksReceived`<br/>`reason` (error/user_cancel)<br/>`errorCategory` (resume_mismatch/stream_closed/network/auth/timeout/rate_limit/overloaded/unknown, only when reason=error) | v0.45.25 (2025-11-14) | (pending release): Added `errorCategory` so NIM-838 resume-mismatch and other Claude Code failures can be separated from the generic error bucket |
| `ai_request_failed` | `AIService.ts:1319` | AI API request fails | `provider`<br/>`errorType` (resume_mismatch/stream_closed/network/auth/timeout/rate_limit/overloaded/unknown)<br/>`retryAttempt` | v0.45.25 (2025-11-14) | (pending release): Added `resume_mismatch` and `stream_closed` buckets to `errorType` |
| `ai_session_resumed` | `AIService.ts:2016` | User intentionally opens session from history (not app startup, tab switching, or session reload) | `provider`<br/>`messageCount` (0, 1, 2-4, 5-9, 10+)<br/>`ageInDays` (today/1-day/2-6-days/1-4-weeks/1-3-months/3-months-plus) | v0.45.25 (2025-11-14) | v0.48.13 (2025-12-17): Fixed to no longer fire on app startup, tab switching, or session reload |
| `cancel_ai_request` | `AIService.ts:1491` | User cancels active AI request | `provider` | v0.45.25 (2025-11-14) |  |
| `ai_diff_accepted` | `DiffApprovalBar.tsx:315, 436`<br/>`TabEditor.tsx:1382` | User accepts diff or all diffs (markdown/code/mockup) | `acceptType` (partial/all)<br/>`replacementCount`<br/>`fileType` (mockup, optional) | v0.45.25 (2025-11-14) |  |
| `ai_diff_rejected` | `DiffApprovalBar.tsx:380, 450`<br/>`TabEditor.tsx:1442` | User rejects diff or all diffs (markdown/code/mockup) | `rejectType` (partial/all)<br/>`replacementCount`<br/>`fileType` (mockup, optional) | v0.45.25 (2025-11-14) |  |
| `session_reparented` | `SessionListItem.tsx:290` | User drags session to change parent (workstream reassignment) | `had_previous_parent`<br/>`workspace_path` | (pending release) |  |
| `ai_effort_level_changed` | `SessionTranscript.tsx` | User changes effort level for Opus 4.6 adaptive reasoning | `effort_level` (low/medium/high/max)<br/>`previous_level` (low/medium/high/max) | (pending release) |  |
| `ai_mode_changed` | `SessionTranscript.tsx` | User switches session mode via ModeTag or Shift+Tab | `from` (planning/agent)<br/>`to` (planning/agent)<br/>`provider` (string)<br/>`session_id` (string) | (pending release) | Auto mode is no longer user-selectable; it activates transparently via the "Allow All" trust level for supported providers |
| `exit_plan_mode_response` | `SessionTranscript.tsx:923, 943, 974, 1060` | User responds to plan completion confirmation | `decision` (approved/denied/start_new_session/cancelled)<br/>`has_feedback` (boolean, for denied only)<br/>`is_worktree` (boolean, for start_new_session only) | (pending release) |  |
| `ask_user_question_answered` | `SessionTranscript.tsx:1081` | User answers an AskUserQuestion prompt from Claude | `numQuestions` (number of questions answered) | (pending release) |  |
| `ask_user_question_cancelled` | `SessionTranscript.tsx:1087` | User cancels an AskUserQuestion prompt | None | (pending release) |  |
| `git_commit_proposal_response` | `GitCommitConfirmationWidget.tsx:600, 672` | User responds to AI-generated git commit proposal | `action` (committed/cancelled/error)<br/>`file_count` (1-5/6-10/11-20/20+)<br/>`success` (boolean, for committed only) | (pending release) |  |

### Claude Code (MCP)

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `claude_code_session_started` | `AIService.ts:2579` | Claude Code provider initializes session | `mcpServerCount`<br/>`slashCommandCount`<br/>`agentCount`<br/>`skillCount`<br/>`pluginCount`<br/>`toolCount`<br/>`helperMethod` (electron/standalone)<br/>`configuredProvider` (optional: anthropic/aws-bedrock/google-vertex/xai/openai/azure-openai/gemini/mistral/groq/cohere) | v0.45.25 (2025-11-14) | (pending release): Added helperMethod property to track which executable method is used for spawning Claude Code subprocess<br/>(pending release): Added configuredProvider property to track which AI provider is configured via environment variables |
| `slash_command_suggestion_clicked` | `SlashCommandSuggestions.tsx:117` | User clicks a slash command suggestion pill in empty session | `commandName`<br/>`packageId` | v0.47.2 (2025-12-10) |  |
| `action_prompt_inserted` | `ActionPromptsDropdown.tsx` | User picks an action from the composer Actions dropdown, inserting its body into the AI draft | `actionCount` (number of actions in the workspace's ai-actions.md)<br/>`bodyLength` (length of the inserted prompt body) | (pending release) |  |

### OpenAI Codex

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `codex_session_started` | `AIService.ts` | Codex provider initializes session (first message) | `model` (e.g., gpt-5.3-codex)<br/>`mcpServerCount`<br/>`isResumedThread` (boolean)<br/>`permissionMode` (optional: allow-all/bypass-all) | (pending release) |  |

### Blitz Mode

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `blitz_created` | `BlitzHandlers.ts:275` | User creates a blitz (parallel worktree sessions) | `worktree_count`<br/>`model_count`<br/>`prompt_length`<br/>`duration_ms`<br/>`error_count` | (pending release) |  |

### Session/File Sharing

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `content_shared` | `ShareHandlers.ts` | User shares a session or file as an encrypted link | `content_type` (session/file)<br/>`is_update` (boolean) | (pending release as of c28302ea) |  |
| `share_deleted` | `ShareHandlers.ts` | User deletes (unshares) a shared session or file | None | (pending release as of c28302ea) |  |

### Session Export

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `session_exported` | `ExportHandlers.ts` | User exports a session as HTML file or copies to clipboard | `format` (html/clipboard/pdf) | (pending release as of c28302ea) |  |

### Claude Code Session Import

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `claude_code_import_dialog_opened` | `ApplicationMenu.ts` | User opens the Import Claude Code Sessions dialog from the File menu | `source` (file_menu) | (pending release) |  |
| `claude_code_import_completed` | `ClaudeCodeSessionHandlers.ts` | Sync of selected Claude Code sessions finishes | `successCount`<br/>`failureCount`<br/>`messagesAdded`<br/>`sessionsRequested` | (pending release) |  |

### Feature Toggles

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `beta_feature_toggled` | `BetaFeaturesPanel.tsx` | User toggles a beta feature or "Enable All" | `feature_tag` (e.g., blitz/codex or 'all')<br/>`enabled` (boolean) | (pending release as of c28302ea) |  |
| `alpha_feature_toggled` | `AdvancedPanel.tsx` | User toggles an alpha feature, "Enable All", or switches release channel | `feature_tag` (e.g., sync/voice-mode/super-loops or 'all')<br/>`enabled` (boolean)<br/>`source` (toggle/channel_switch) | (pending release as of c28302ea) |  |
| `auto_commit_toggled` | `AdvancedPanel.tsx` | User toggles auto-approve commits setting | `enabled` (boolean) | (pending release as of c28302ea) |  |

### MCP Server Configuration

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `mcp_server_added` | `MCPServersPanel.tsx:1003` | User successfully saves an MCP server configuration (add or edit) | `templateId` (null if custom)<br/>`scope` (user/workspace)<br/>`isCustom`<br/>`authType` (oauth/api-key/none)<br/>`transportType` (stdio/sse/http)<br/>`isNew` (true if adding, false if editing) | (pending release as of 4734f601) | (pending release as of 8a7a1220): Renamed from mcp_server_configured, added isNew property, added http transportType |
| `mcp_server_test_result` | `MCPServersPanel.tsx:1134` | User tests MCP server connection | `templateId` (null if custom)<br/>`success`<br/>`errorType` (command_not_found/timeout/auth_failure/network/other/exception, only on failure)<br/>`durationMs` | (pending release as of 4734f601) |  |
| `mcp_oauth_authorize` | `MCPServersPanel.tsx:805,817,830,914` | OAuth authorization attempt completes (success or failure) | `templateId` (null if custom)<br/>`success`<br/>`errorType` (stale_port/auth_rejected/exception, only on failure) | (pending release as of 4734f601) | (pending release as of 8a7a1220): Renamed from mcp_oauth_result, added stale_port errorType |

### Terminal

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `terminal_created` | `TerminalHandlers.ts:118` | User creates a new terminal session | `shell` (zsh/bash/fish/unknown)<br/>`source` (panel/worktree) | (pending release as of 9830e6b0) | (pending release): Added source property |

### AI Tool Execution

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `apply_diff_tool` | `ToolExecutor.ts:55` | AI applies diff/code replacement via tool | None | v0.45.25 (2025-11-14) |  |
| `ai_stream_content_used` | `ToolExecutor.ts:115` | AI streams content to document via tool | None | v0.45.25 (2025-11-14) |  |
| `create_document_tool` | `ToolExecutor.ts:245` | AI creates new document via tool | None | v0.45.25 (2025-11-14) |  |
| `execute_custom_tool` | `ToolExecutor.ts:358` | AI executes custom MCP tool | None | v0.45.25 (2025-11-14) |  |

### AI Configuration

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `ai_provider_configured` | `GlobalSettingsScreen.tsx:276` | User enables/disables AI provider in settings | `provider`<br/>`modelCount`<br/>`action` (enabled/disabled) | v0.45.25 (2025-11-14) |  |
| `ai_model_selected` | `GlobalSettingsScreen.tsx:377` | User selects specific AI model | `provider`<br/>`modelName` | v0.45.25 (2025-11-14) |  |

### Attachments

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `add_attachment` | `AttachmentService.ts:112` | User attaches file to AI chat message | None | v0.45.25 (2025-11-14) |  |
| `delete_attachment` | `AttachmentService.ts:148` | User removes attachment from message | None | v0.45.25 (2025-11-14) |  |

### Project Settings & Packages

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `project_settings_opened` | `ProjectSettingsScreen.tsx:55` | User opens project settings screen | `isFirstTime`<br/>`totalPackages`<br/>`installedPackages` | v0.45.25 (2025-11-14) |  |
| `package_installed` | `ProjectSettingsScreen.tsx:79` | User successfully installs package | `packageId`<br/>`packageName` | v0.45.25 (2025-11-14) |  |
| `package_install_failed` | `ProjectSettingsScreen.tsx:91` | Package installation fails | `packageId`<br/>`error` | v0.45.25 (2025-11-14) |  |
| `package_uninstalled` | `ProjectSettingsScreen.tsx:116` | User successfully uninstalls package | `packageId`<br/>`packageName` | v0.45.25 (2025-11-14) |  |
| `package_uninstall_failed` | `ProjectSettingsScreen.tsx:128` | Package uninstallation fails | `packageId`<br/>`error` | v0.45.25 (2025-11-14) |  |

### Extensions

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `extension_toggled` | `InstalledExtensionsPanel.tsx:81` | User enables or disables an extension | `action` (enabled/disabled) | v0.45.25 (2025-11-14) |  |

### Menu & Application

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `menu_action_used` | `ApplicationMenu.ts:476, 968` | User clicks certain menu items | Varies by menu item | v0.45.25 (2025-11-14) |  |
| `global_settings_opened` | `ApplicationMenu.ts:517, 1282`<br/>`AIModelsWindow.ts:50` | User opens global settings or AI models window | None | v0.45.25 (2025-11-14) |  |
| `help_accessed` | `ApplicationMenu.ts:1336, 1348, 1363, 1381, 1396, 1408, 1423` | User clicks help menu items | Varies by help item | v0.45.25 (2025-11-14) |  |
| `keyboard_shortcut_used` | `AnalyticsHandlers.ts:29` | User triggers keyboard shortcut (reported from renderer) | `shortcut`<br/>`context` | v0.45.25 (2025-11-14) |  |
| `toolbar_button_clicked` | `AnalyticsHandlers.ts:37` | User clicks toolbar button (reported from renderer) | `button`<br/>`isFirstUse` | v0.45.25 (2025-11-14) |  |
| `social_link_clicked` | `DiscordInvitation.tsx:99` | User clicks a social media link or Discord link in the community popup | `channel` (discord/linkedin/youtube/x/tiktok/instagram) | (pending release) |  |

### System & Database

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `uncaught_error` | `ErrorNotificationService.ts:210, 242` | Uncaught exception or unhandled promise rejection in renderer | `errorType` (exception/unhandled_rejection)<br/>`errorCategory` (TypeError/ReferenceError/Error/etc) | v0.47.2 (2025-12-10) |  |
| `database_error` | `PGLiteDatabaseWorker.ts:255, 275` | Database operation fails | `operation` (read/write)<br/>`errorType`<br/>`tableName` | v0.45.25 (2025-11-14) |  |
| `database_corruption_detected` | `PGLiteDatabaseWorker.ts:131` | Database corruption detected during initialization | `hasBackups` | v0.45.25 (2025-11-14) |  |
| `database_corruption_recovery_choice` | `PGLiteDatabaseWorker.ts:153, 215, 222, 272` | User makes a choice in database corruption recovery dialog | `choice` (restore_from_backup/start_fresh/auto_fresh)<br/>`confirmed` (for start_fresh)<br/>`reason` (for auto_fresh) | v0.45.25 (2025-11-14) |  |
| `database_corruption_restore_result` | `PGLiteDatabaseWorker.ts:165, 185, 232, 253` | Result of attempting to restore from backup | `success`<br/>`source` (current/previous)<br/>`errorType` (verification_failed/restore_failed)<br/>`trigger` (cancel_start_fresh) | v0.45.25 (2025-11-14) |  |
| `database_init_failed_with_backups` | `PGLiteDatabaseWorker.ts:333` | Database initialization failed but backups are available | `hasBackups` (always true) | (pending release) |  |
| `database_init_failed_recovery_choice` | `PGLiteDatabaseWorker.ts:343, 399, 408` | User makes a choice in init failure recovery dialog | `choice` (restore_from_backup/start_fresh)<br/>`confirmed` (for start_fresh) | (pending release) |  |
| `known_error` | Various (see Known Error IDs below) | A recognized error condition occurs that we want to track and monitor | `errorId` (see Known Error IDs)<br/>`context` (where the error occurred)<br/>`errorMessage` (optional, truncated) | (pending release as of c597008b) |  |
| `feature_first_use` | `AIService.ts:406`<br/>`WindowManager.ts:230`<br/>`AnalyticsHandlers.ts:45` | User uses a feature for the first time | `feature`<br/>`daysSinceInstall` | v0.45.25 (2025-11-14) |  |
| `migration_completed` | `MigrationOrchestrator.ts` | PGLite → SQLite migration finished successfully | `pglite_dir_size_bytes` (gauge of pre-migration store size)<br/>`target_row_count` (total rows migrated)<br/>`duration_ms`<br/>`tables_migrated`<br/>`spot_check_count`<br/>`foreign_key_violations`<br/>`integrity_check` ("ok") | (pending release) |  |
| `migration_failed` | `MigrationOrchestrator.ts` | PGLite → SQLite migration aborted before cutover | `phase` (closing-pglite / opening-pglite / opening-sqlite / migrating / verifying-* / cutover)<br/>`message` (first 500 chars of error) | (pending release) |  |
| `pglite_legacy_dir_present` | `database/initialize.ts` | Heartbeat fired at startup when a `pglite-db.migrated-*` directory still exists; gates the decision to retire the PGLite reader | `active_backend` (sqlite/pglite) | (pending release) |  |
| `migration_dry_run_completed` | `ipc/MigrationHandlers.ts` | Alpha-grade preview: migration ran against a live PGLite to a throwaway SQLite dir without cutover | `target_row_count`<br/>`duration_ms`<br/>`tables_migrated`<br/>`sqlite_file_bytes` (estimated post-cutover footprint)<br/>`pglite_dir_bytes` (current PGLite footprint)<br/>`foreign_key_violations`<br/>`integrity_check` | (pending release) |  |
| `migration_dry_run_failed` | `ipc/MigrationHandlers.ts` | Dry-run aborted before completion (schema open / read / verification failure) | `message` (first 500 chars of error) | (pending release) |  |

#### Known Error IDs

The `known_error` event uses an `errorId` property to identify specific error conditions. This allows us to track patterns of known issues without creating a separate event for each one.

| Error ID | File(s) | Description | Additional Properties |
| --- | --- | --- | --- |
| `pglite_wasm_runtime_crash` | `index.ts:418` | PGLite WASM runtime crashed during database initialization (often resolved by restarting computer) | `context`: database_initialization |
| `database_initialization_failed` | `index.ts:424` | Database initialization failed for unknown reasons | `context`: database_initialization<br/>`errorMessage`: truncated error |
| `image_compression_failed` | `AttachmentService.ts:136` | Image compression failed when saving attachment (original image is used as fallback) | `context`: attachment_save<br/>`errorType`: heic_decode_failed/unsupported_format/compression_failed/unexpected<br/>`mimeType`: original image mime type |
| `share_upload_failed` | `ShareHandlers.ts` | Share upload failed (session or file) | `context`: share<br/>`content_type`: session/file |
| `share_not_signed_in` | `ShareHandlers.ts` | User attempted to share but is not signed in | `context`: share<br/>`content_type`: session/file |

### Onboarding & Walkthrough

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `developer_mode_changed` | `App.tsx`<br/>`AdvancedPanel.tsx` | User changes developer mode setting (initial or subsequent) | `developer_mode` (boolean)<br/>`source` (onboarding/settings)<br/>`is_initial` (boolean) | (pending release) |  |
| `unified_onboarding_skipped` | `App.tsx` | User skips the unified onboarding flow | None | (pending release) | Replaces `onboarding_skipped` |
| ~~`feature_walkthrough_completed`~~ | ~~`FeatureWalkthrough.tsx`~~ | ~~User completes or skips the feature walkthrough~~ | ~~`total_time_ms`<br/>`slide_times` (object with editor/mockup/agent keys)<br/>`skipped` (boolean)<br/>`skipped_at_slide` (editor/mockup/agent, only if skipped)~~ | v0.45.25 (2025-11-14) | **DEPRECATED**: No longer sent; walkthrough slides removed in unified onboarding |
| ~~`onboarding_completed`~~ | ~~`OnboardingDialog.tsx`~~ | ~~User completes the role/email onboarding dialog~~ | ~~`user_role`<br/>`custom_role_provided`<br/>`custom_role_text`<br/>`email_provided`~~ | v0.45.25 (2025-11-14) | **DEPRECATED**: Replaced by `unified_onboarding_completed`, then re-used (see below) |
| `onboarding_completed` | `useOnboarding.ts` | User completes the unified onboarding dialog (has role or referral data) | `user_role` (raw value, e.g. `developer`, `product_manager`, `other`)<br/>`custom_role_text` (only when user typed a custom role)<br/>`referral_source` (raw value, e.g. `search`, `social`, `ai`, `other`)<br/>`referral_ai_detail` (only for `ai` referral)<br/>`referral_other_detail` (only for `other` referral)<br/>`referral_social_detail` (only for `social` referral)<br/>`developer_mode` (boolean)<br/>`email_provided` (boolean) | (pending release) | Replaces programmatic `survey sent` for the Onboarding Profile Survey. Property names and raw values match the existing `Devs` / `Product Managers` / `role_other` cohorts. |
| ~~`onboarding_deferred`~~ | ~~`App.tsx`~~ | ~~User clicks "Ask me later" on onboarding dialog~~ | ~~None~~ | v0.45.25 (2025-11-14) | **DEPRECATED**: Removed in unified onboarding |
| ~~`onboarding_skipped`~~ | ~~`App.tsx`~~ | ~~User clicks "Never ask again" on onboarding dialog~~ | ~~None~~ | v0.45.25 (2025-11-14) | **DEPRECATED**: Replaced by `unified_onboarding_skipped` |
| `claude_commands_toast_shown` | `App.tsx:894` | Claude commands install toast is displayed | None | v0.47.2 (2025-12-10) |  |
| `claude_commands_toast_install_all` | `App.tsx:1654` | User clicks "Install All" on commands toast | None | v0.47.2 (2025-12-10) |  |
| `claude_commands_toast_settings` | `App.tsx:1663` | User clicks "Settings" on commands toast | None | v0.47.2 (2025-12-10) |  |
| `claude_commands_toast_skip` | `App.tsx:1673` | User clicks "Skip" on commands toast | None | v0.47.2 (2025-12-10) |  |
| `windows_claude_code_warning_shown` | `useOnboarding.ts:186` | User clicks "Open Settings" in Windows Claude Code warning dialog | None | (pending release) |  |
| `windows_claude_code_warning_closed` | `useOnboarding.ts:178` | User closes Windows Claude Code warning dialog | None | (pending release) |  |
| `windows_claude_code_warning_dismissed_forever` | `useOnboarding.ts:182` | User clicks "Don't show again" on Windows Claude Code warning | None | (pending release) |  |

### Surveys & Feedback

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `feedback_intake_launched` | `FeedbackIntakeDialog.tsx` | User picks a path in the feedback intake dialog (bug or feature). Spawns a guided agent session. | `kind` (`'bug' \ | 'feature'`)<br/>`mayGatherLogs` (boolean — whether the user opted in to log gathering on the intake screen) | (pending release) | (pending release): Replaces the legacy PostHog `survey shown/dismissed/sent` events. |
| `feedback_external_link_clicked` | `FeedbackIntakeDialog.tsx` | User clicks one of the secondary links in the feedback dialog footer (existing issues, discussions, support email). | `target` (`'issues' \ | 'discussions' \ | 'email'`) | (pending release) |  |

### Permissions

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `agent_permissions_opened` | `ProjectPermissionsPanel.tsx:75` | User opens the agent permissions settings panel | `isTrusted`<br/>`permissionMode`<br/>`allowedPatternsCount`<br/>`additionalDirectoriesCount` | (pending release as of d00c15df) |  |
| `permission_setting_changed` | `ProjectPermissionsPanel.tsx` | User changes any permission setting | `action` (trust_workspace/revoke_trust/change_mode/remove_pattern/reset_to_defaults/add_directory/remove_directory/add_url_pattern/remove_url_pattern/allow_all_domains/revoke_all_domains)<br/>`mode` (only for change_mode action) | (pending release as of d00c15df) |  |
| `tool_permission_responded` | `SessionTranscript.tsx:1112` | User responds to tool permission request via widget | `decision` (allow/deny)<br/>`scope` (once/session/always/always-all) | (pending release as of d00c15df) | (pending release): Migrated to widget-based tracking in SessionTranscript; removed toolCategory property |
| `trust_dialog_saved` | `ProjectTrustToast.tsx:151` | User saves trust choice in dialog | `permissionMode` (ask/allow-all/bypass-all)<br/>`isChangingMode` | (pending release as of d00c15df) |  |

### Auto-Update

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `update_toast_shown` | `updateListeners.ts` -> `AnalyticsHandlers.ts` | Update available toast actually displayed to user (after suppression checks pass). Fires at most once per distinct `newVersion` per app run -- not on every electron-updater 'update-available' callback, which re-fires hourly. | `release_channel` (stable/alpha)<br/>`new_version` | (pending release) | (pending release): Moved fire site from `autoUpdater.ts` (main) to `updateListeners.ts` (renderer); (pending release): Tightened dedup to once-per-version-per-run because the prior state-based guard still re-fired after the toast dismissed back to 'idle'. |
| `update_toast_action` | `UpdateToast.tsx` | User clicks button on update toast | `action` (download_clicked/release_notes_clicked/remind_later_clicked)<br/>`new_version` | (pending release) |  |
| `update_download_started` | `autoUpdater.ts` | User initiates update download | `release_channel` (stable/alpha)<br/>`new_version` | (pending release) |  |
| `update_download_completed` | `autoUpdater.ts` | Update download finishes successfully | `release_channel` (stable/alpha)<br/>`new_version`<br/>`duration_category` (fast/medium/slow) | (pending release) |  |
| `update_install_initiated` | `autoUpdater.ts` | User clicks relaunch to install update | `new_version` | (pending release) |  |
| `update_error` | `autoUpdater.ts` | Error during update check, download, or install. Background-check path is deduped to once per distinct (`stage`, `error_type`) per app run; the key resets on a successful `update-available` or `update-not-available` so a transient error that recurs after the network heals is still captured. The download-failure branch in the manual toast flow is not deduped. | `stage` (check/download/install)<br/>`error_type` (network/permission/disk_space/signature/unknown)<br/>`release_channel` (stable/alpha) | (pending release) | (pending release): Added (`stage`, `error_type`) dedup on the background path because hourly auto-checks were re-firing the same network/check error every poll. |

### Special System Events

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `user_created` | `index.ts:736` | Very first app launch only (launchCount === 1) - fires once per user | `$set_once: first_seen_version` | (pending release) |  |
| `nimbalyst_session_start` | `AnalyticsService.ts:154` | Application starts (sent even for opted-out users) | `$session_id`<br/>`has_git_installed`<br/>`$set: nimbalyst_version`<br/>`$set: cpu_arch`<br/>`$set_once: is_dev_user`<br/>`$set_once: is_dev_install` | v0.45.25 (2025-11-14) |  |
| `analytics_opt_out` | `AnalyticsService.ts:89` | User opts out of analytics in settings | None | v0.45.25 (2025-11-14) |  |
| `first_launch_claude_check` | `index.ts:114` | Very first app launch only - checks if Claude Code is installed | `hasClaudeInstalled` (boolean) | v0.47.2 (2025-12-10) |  |
| `quit_confirmation_shown` | `index.ts:757` | User attempts quit with active AI session | `reason` (active_ai_session) | v0.45.25 (2025-11-14) |  |
| `quit_confirmation_result` | `index.ts:774, 783` | User responds to quit confirmation dialog | `result` (quit_anyway/cancelled) | v0.45.25 (2025-11-14) |  |
| `app_foregrounded` | `WindowHandlers.ts:172` | Any window gains focus (throttled to once per 30 minutes). Used for DAU tracking - counts users who actively bring Nimbalyst to the foreground, not those who leave it running in the background. | None | (pending release) |  |

### Account & Sync

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `sync_sign_in_started` | `SyncPanel.tsx` | User clicks Google sign-in or sends magic link | `method` (google/magic_link) | (pending release) |  |
| `sync_sign_in_completed` | `SyncPanel.tsx` | Auth state transitions from unauthenticated to authenticated | None | (pending release) |  |
| `sync_sign_out` | `SyncPanel.tsx` | User clicks sign out | None | (pending release) |  |
| `sync_enabled` | `SyncPanel.tsx` | User enables session sync toggle | `projectCount` (exact number) | (pending release) |  |
| `sync_disabled` | `SyncPanel.tsx` | User disables session sync toggle | `projectCount` (exact number) | (pending release) |  |
| `sync_qr_pairing_opened` | `SyncPanel.tsx` | User opens the QR pairing modal | None | (pending release) |  |
| `sync_auth_callback_completed` | `StytchAuthService.ts` | Deep link auth callback completes successfully (authoritative sign-in) | None | (pending release) |  |

### Voice Mode

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `voice_mode_enabled` | `appSettings.ts:135` | User enables voice mode in settings | None | (pending release) |  |
| `voice_mode_disabled` | `appSettings.ts:135` | User disables voice mode in settings | None | (pending release) |  |
| `voice_session_started` | `VoiceModeService.ts:479` | User starts a voice session (clicks mic button) | None | (pending release) |  |
| `voice_session_ended` | `VoiceModeService.ts:36` | Voice session ends | `reason` (user_stopped/timeout/error)<br/>`durationCategory` (short < 1min / medium 1-5min / long > 5min) | (pending release) |  |

### Mobile App

| Event Name | File(s) | Trigger | Properties | First Added (Public) | Significant Changes |
| --- | --- | --- | --- | --- | --- |
| `mobile_app_opened` | `main.tsx:15, 24` | App launches or returns to foreground | `platform` (ios)<br/>`$set: nimbalyst_mobile_version` | (pending release) |  |
| `mobile_session_viewed` | `SessionDetailScreen.tsx:252` | User opens a session | None (privacy - no session details) | (pending release) |  |
| `mobile_project_selected` | `ProjectListScreen.tsx:74` | User taps on a project | None (privacy - no project names) | (pending release) |  |
| `mobile_ai_message_sent` | `SessionDetailScreen.tsx:648` | User sends a message to AI from mobile | `hasAttachments` (boolean) | (pending release) |  |
| `mobile_pairing_completed` | `SettingsScreen.tsx:134` | QR code scan successful | None | (pending release) |  |
| `mobile_login_completed` | `SettingsScreen.tsx:63` | User completes Stytch authentication | None | (pending release) |  |
| `mobile_analytics_opt_out` | `AnalyticsService.ts:93` | User opts out of analytics | None | (pending release) |  |
| `mobile_meta_agent_created` | `SessionListView.swift` | User creates a Meta Agent from the create menu (alpha-gated) | `model` (string) | (pending release) |  |

### Mobile App (Capacitor)

Events from the iOS companion app. These events share the same PostHog project and analytics ID (via QR pairing) as the desktop app.


## Event Summary Statistics

- **Total Events**: 118 unique event names
- **Main Process Events**: 57 (via AnalyticsService)
- **Renderer Process Events**: 53 (via usePostHog hook)
- **Mobile Events**: 7 (via Capacitor AnalyticsService)
- **File Operations**: 7 events
- **Workspace Operations**: 4 events
- **Navigation & Editor Mode**: 4 events
- **Session Kanban Board**: 6 events
- **File History**: 2 events
- **AI-Related**: 23 events
- **Blitz Mode**: 1 event
- **Session/File Sharing**: 2 events
- **Session Export**: 1 event
- **Feature Toggles**: 3 events
- **MCP Configuration**: 3 events
- **Terminal**: 1 event
- **Extensions**: 1 event
- **Account & Sync**: 7 events
- **Onboarding**: 8 events
- **Surveys & Feedback**: 3 events
- **Permissions**: 4 events
- **Auto-Update**: 6 events
- **Voice Mode**: 3 events
- **System/Infrastructure**: 13 events

## Super Properties (on every event)

These properties are attached to every event automatically.

| Property | Type | Set By | Description |
| --- | --- | --- | --- |
| `nimbalyst_version` | `string` | `AnalyticsService.ts` (main), `index.tsx` (renderer via `register()`) | App version (e.g., `0.53.1`). Available on all events from both processes. |

## Person Properties

Person properties are attached to user profiles in PostHog via `posthog.people.set()`. These persist across sessions and allow segmentation and filtering.

| Property | Type | Set By | Description |
| --- | --- | --- | --- |
| `email` | `string` | `useOnboarding.ts` | User's email address (if provided during onboarding) |
| `user_role` | `string` | `useOnboarding.ts` | User's role as raw enum value (`developer`, `product_manager`, `designer`, `writer`, `researcher`, `marketing`, `sales`, `finance`, `student`, `hobbyist`, `other`). Cohorts and breakdowns filter on these exact values. |
| `custom_role_text` | `string` | `useOnboarding.ts` | Free-text role typed by the user when they picked "Other" (only set in that case) |
| `referral_source` | `string` | `useOnboarding.ts` | How user heard about Nimbalyst as raw enum value (`search`, `social`, `friend`, `ai`, `ad`, `other`) |
| `referral_ai_detail` | `string` | `useOnboarding.ts` | Specific AI tool when `referral_source = 'ai'` |
| `referral_other_detail` | `string` | `useOnboarding.ts` | Free-text detail when `referral_source = 'other'` |
| `referral_social_detail` | `string` | `useOnboarding.ts` | Specific platform when `referral_source = 'social'` |
| `developer_mode` | `boolean` | `App.tsx` (onboarding)<br/>`AdvancedPanel.tsx` (settings) | Whether developer mode is enabled |
| `first_seen_version` | `string` | `index.ts` (first launch) | Set via `$set_once` - the app version when user first launched |
| `is_dev_user` | `boolean` | `AnalyticsService.ts` | Set via `$set_once` - true for development/non-official builds |
| `is_dev_install` | `boolean` | `AnalyticsService.ts` | Set via `$set_once` - true if installed from dev build |
| `cpu_arch` | `string` | `AnalyticsService.ts` | `process.arch` value (`arm64`, `x64`, `ia32`, etc.) - set on each session start via `$set` |
| `nimbalyst_mobile_version` | `string` | Mobile `main.tsx` | Mobile app version (iOS/Android) |

## Surveys

Surveys are configured in PostHog and can be either popover (shown in-app) or API (programmatically submitted).

| Survey ID | Name | Type | Questions | Submitted From |
| --- | --- | --- | --- | --- |
| ~~`019becdc-8139-0000-0946-e76c18c36ef7`~~ | ~~Onboarding Profile Survey~~ | ~~API~~ | ~~1. What best describes your role?<br/>2. How did you hear about Nimbalyst?~~ | ~~`useOnboarding.ts`~~ — **REMOVED**: replaced by `onboarding_completed` custom event |

## Privacy Requirements

All events MUST follow these privacy rules:

1. **Never include PII**: No usernames, emails, IP addresses, or identifying information
2. **No file paths**: Use categories/buckets instead of actual paths
3. **No API keys**: Never include authentication tokens or credentials
4. **Anonymous distinctId**: Use auto-generated anonymous ID, never override
5. **Categorical properties**: Use bucketed values (small/medium/large) instead of exact values

## Development vs Production

- **Dev users**: Automatically marked with `is_dev_user: true` property (via `$set_once`)
- **Dev builds**: Any non-official build (local builds, development mode)
- **Official builds**: Created by GitHub release workflow with `OFFICIAL_BUILD=true`
- **Filtering**: Use `WHERE is_dev_user != true` in PostHog to exclude dev users

## Adding New Events

When adding new events:

1. **Choose the right context**: Main process (AnalyticsService) or renderer (usePostHog)
2. **Follow naming conventions**: Use `snake_case`, `noun_verb` pattern
3. **Use categorical properties**: Bucket values instead of exact numbers
4. **Update this document**: Add the event to the appropriate table with version columns:
  - Set "First Added (Public)" to `(pending release as of <commit-hash>)` until publicly released
  - Leave "Significant Changes" empty for new events
5. **Document in code**: Add comment explaining what the event tracks
6. **When modifying events**: Add entry to "Significant Changes" column (see Version Tracking section)

## Reference Documentation

- Analytics implementation guide: `docs/ANALYTICS_GUIDE.md`
- AnalyticsService: `packages/electron/src/main/services/analytics/AnalyticsService.ts`
- Privacy requirements: See ANALYTICS_GUIDE.md "Critical Privacy Requirements"
