/**
 * Repo-side mirror of the PostHog server-side ingestion allow-list.
 *
 * PostHog project 234047 runs a transformation named `Cost control allow-list`
 * (hog function 01a06d5f-4e7f-0000-e72c-e157df4146b8, execution order 1) that
 * DROPS EVERY EVENT WHOSE NAME IS NOT ON THE ALLOW-LIST, before ingestion.
 * A capture call for an unlisted event is constructed, serialized, sent, and
 * then silently discarded -- no error, no log, no data.
 *
 * It exists because the org was ingesting ~6.5M events/month against a
 * 1M/month free tier. It is the reason the PostHog bill is zero.
 *
 * THIS FILE IS A MIRROR, NOT THE SOURCE OF TRUTH. The transformation in
 * PostHog decides what is actually ingested. Changing this file alone changes
 * nothing; changing the transformation without updating this file makes the
 * `check:analytics-allowlist` gate wrong. Change both, together.
 *
 * Every event name that appears in source must be in exactly one of the four
 * lists below, which is what `scripts/check-analytics-allowlist.mjs` enforces.
 * The point is to make "will this event actually arrive?" an explicit decision
 * at review time rather than something discovered months later.
 *
 * See docs/POSTHOG_EVENTS.md, "A server-side allow-list drops unknown events".
 */

/**
 * Ingested at 100%. Rare, high-signal: identity, activation, conversions,
 * errors, and the mobile and collaboration surfaces.
 */
export const INGESTED_ALWAYS = [
  'ai_message_sent',
  'user_created',
  'onboarding_completed',
  'feature_first_use',
  'tutorial_started',
  'walkthrough_completed',
  'tip_navigated',
  'uncaught_error',
  'ai_request_failed',
  'file_save_failed',
  'ai_provider_configured',
  'sync_auth_callback_completed',
  'mobile_app_opened',
  'mobile_ai_message_sent',
  'mobile_session_created',
  'mobile_ask_user_question_response',
  'mobile_tool_permission_response',
  'mobile_session_cancelled',
  'collab_home_opened',
  'team_surface_opened',
  'collab_document_opened',
  'update_toast_action',
  'extension_marketplace_installed',
  'extension_toggled',
  'worktree_created',
  'mcp_server_added',
  'claude_plugin_installed',
] as const;

/**
 * Ingested on a distinct-id-aware panel rather than in full -- high volume,
 * trend-only value.
 *
 * The panel is `sha256Hex(distinct_id)` first hex character in PANEL_BUCKETS,
 * so the SAME users are kept across every sampled event. Funnels and per-user
 * rates stay exact within the panel; ABSOLUTE TOTALS MUST BE MULTIPLIED BY
 * 16 / PANEL_BUCKETS.length. Anyone reading a raw count of these events
 * without scaling it will be wrong by that factor.
 */
export const INGESTED_SAMPLED = [
  'nimbalyst_session_start',
  'update_error',
  'tip_shown',
  'claude_code_session_started',
  'codex_session_started',
  'walkthrough_started',
  'walkthrough_dismissed',
  'database_error',
  'database_backend_active',
  'mobile_project_selected',
  'mobile_session_viewed',
] as const;

/** Hex buckets kept by the sampled panel. Two of sixteen = 12.5%. */
export const PANEL_BUCKETS = ['0', '1'] as const;

/**
 * Emitted by the PostHog SDKs themselves rather than by our code, so they
 * never appear at a call site in this repo. Listed here so the gate does not
 * report them as a stale allow-list entry.
 */
export const SDK_OWNED = [
  '$identify',
  '$create_alias',
  '$opt_in',
  '$workflows_conversion',
] as const;

/**
 * Emitted by our code and deliberately discarded at ingestion.
 *
 * These are not dead code -- the call sites still run, they just produce no
 * data. Most are UI-navigation or high-frequency telemetry whose per-user
 * volume was the reason the allow-list exists at all.
 *
 * If you want one of these back, move it to INGESTED_ALWAYS or
 * INGESTED_SAMPLED *and* add it to the transformation in PostHog. If a call
 * site is genuinely worthless, prefer deleting the call site over leaving it
 * here burning client CPU to produce something nobody receives.
 */
export const INTENTIONALLY_DROPPED = [
  '$set',
  'account_deletion_completed',
  'account_deletion_confirmed',
  'account_deletion_failed',
  'account_deletion_started',
  'action_prompt_inserted',
  'action_prompt_launched_new_session',
  'add_attachment',
  'agent_permissions_opened',
  'ai_diff_accepted',
  'ai_diff_rejected',
  'ai_effort_level_changed',
  'ai_message_queued',
  'ai_model_selected',
  'ai_response_received',
  'ai_session_resumed',
  'ai_stream_content_used',
  'ai_stream_interrupted',
  'ai_thinking_mode_changed',
  'alpha_feature_toggled',
  'analytics_opt_out',
  'app_foregrounded',
  'apply_diff_tool',
  'ask_user_question_answered',
  'ask_user_question_cancelled',
  'auto_commit_toggled',
  'beta_feature_toggled',
  'blitz_created',
  'cancel_ai_request',
  'check_claude_code_windows_installation',
  'check_claude_login_error',
  'check_claude_login_status',
  'claude_code_import_completed',
  'claude_code_import_dialog_opened',
  'closed',
  'collab_document_action',
  'collab_document_created',
  'collab_document_first_edited',
  'collab_folder_created',
  'collab_folder_deleted',
  'collab_folder_link_copied',
  'collab_folder_moved',
  'collab_folder_renamed',
  'collab_home_searched',
  'collab_operation_failed',
  'collab_outbox_replay_completed',
  'collab_server_mutation_rejected',
  'collab_share_asset_migration_completed',
  'collab_sync_attempt_completed',
  'construct',
  'content_mode_switched',
  'content_shared',
  'create_document_tool',
  'database_corruption_detected',
  'database_corruption_recovery_choice',
  'database_corruption_restore_result',
  'database_init_failed_recovery_choice',
  'database_init_failed_with_backups',
  'database_init_failure_dialog',
  'database_lock_ambiguous_cancel',
  'database_lock_ambiguous_force_unlock',
  'delete_attachment',
  'developer_mode_changed',
  'do_claude_code_login',
  'do_claude_code_logout',
  'editor_type_opened',
  'execute_custom_tool',
  'exit_plan_mode_response',
  'extension_claude_plugin_toggled',
  'extension_marketplace_risk_accepted',
  'extension_marketplace_uninstalled',
  'extension_marketplace_updated',
  'extension_marketplace_viewed',
  'extension_panel_toggled',
  'feedback_external_link_clicked',
  'feedback_intake_launched',
  'feedback_intake_type_selected',
  'file_created',
  'file_deleted',
  'file_history_opened',
  'file_history_restored',
  'file_opened',
  'file_opened_in_external_editor',
  'file_renamed',
  'first_launch_claude_check',
  'global_settings_opened',
  'help_accessed',
  'invite_browser_instead_chosen',
  'invite_deep_link_followed',
  'invite_download_clicked',
  'invite_handoff_shown',
  'invite_landing_viewed',
  'kanban_card_archived',
  'kanban_card_opened',
  'kanban_card_peeked',
  'kanban_card_phase_changed',
  'kanban_column_batch_move',
  'kanban_column_collapsed',
  'kanban_filter_applied',
  'keyboard_shortcut_used',
  'known_error',
  'mcp_oauth_authorize',
  'mcp_server_test_result',
  'menu_action_used',
  'message',
  'migration_dry_run_completed',
  'migration_dry_run_failed',
  'mobile_account_deleted',
  'mobile_analytics_opt_out',
  'mobile_child_session_created',
  'mobile_convert_to_workstream',
  'mobile_device_unpairing',
  'mobile_exit_plan_mode_response',
  'mobile_git_commit_response',
  'mobile_login_completed',
  'mobile_login_started',
  'mobile_meta_agent_created',
  'mobile_pairing_completed',
  'mobile_push_requested',
  'mobile_request_user_input_response',
  'mobile_workstream_created',
  'mobile_worktree_created',
  'permission_setting_changed',
  'pglite_corruption_backup_present',
  'pglite_legacy_dir_present',
  'quit_confirmation_result',
  'quit_confirmation_shown',
  'release_channel_changed',
  'request_user_input_answered',
  'request_user_input_cancelled',
  'rosetta_warning_closed',
  'rosetta_warning_dismissed_forever',
  'rosetta_warning_download_clicked',
  'session_exported',
  'session_list_filter_applied',
  'session_reparented',
  'session_view_mode_switched',
  'share_deleted',
  'slash_command_suggestion_clicked',
  'social_link_clicked',
  'super_loop_blocked_feedback_submitted',
  'sync_add_account',
  'sync_disabled',
  'sync_enabled',
  'sync_qr_pairing_opened',
  'sync_remove_account',
  'sync_sign_out',
  'team_invitation_accepted',
  'team_invitation_sent',
  'team_member_removed',
  'team_member_role_changed',
  'team_operation_failed',
  'team_organization_created',
  'team_organization_deleted',
  'team_organization_merged',
  'team_organization_switched',
  'team_project_access_changed',
  'team_project_added',
  'team_project_identity_changed',
  'team_project_moved',
  'team_project_walk_completed',
  'team_project_walk_presented',
  'team_sign_in_completed',
  'terminal_created',
  'terminal_panel_opened',
  'theme_changed',
  'tip_action_clicked',
  'tip_all_tips_opened',
  'tool_permission_responded',
  'toolbar_button_clicked',
  'tracker_drain_aborted',
  'tracker_item_clicked',
  'tracker_item_mutated',
  'tracker_item_scope_changed',
  'tracker_mutation_rejected',
  'tracker_quick_create_duplicate_opened',
  'tracker_quick_create_duplicates_shown',
  'tracker_quick_create_item_created',
  'tracker_table_sort',
  'trust_dialog_saved',
  'tutorial_progressed',
  'unified_onboarding_skipped',
  'update_download_completed',
  'update_download_started',
  'update_install_deferred',
  'update_install_initiated',
  'update_toast_shown',
  'voice_model_fallback',
  'voice_prompt_submitted',
  'voice_session_ended',
  'voice_session_started',
  'voice_voice_mismatch',
  'walkthrough_step_viewed',
  'windows_claude_code_warning_closed',
  'windows_claude_code_warning_dismissed_forever',
  'windows_claude_code_warning_shown',
  'workspace_file_tree_expanded',
  'workspace_opened',
  'workspace_opened_with_filter',
  'workspace_search_used',
  'worktree_archive_completed',
  'worktree_archive_failed',
  'worktree_archived',
  'worktree_merge_attempted',
  'worktree_rebase_attempted',
] as const;

export type IngestedEventName =
  | (typeof INGESTED_ALWAYS)[number]
  | (typeof INGESTED_SAMPLED)[number];
