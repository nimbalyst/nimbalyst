# Weekly Users Dashboard

Rules and conventions for the PostHog "Weeklys" dashboard (ID: 1331038).

## Base View

All insights on this dashboard MUST query from the `WEEKLY_USERS_BASE_VIEW` materialized view in PostHog. This view contains one row per user per week with activity metrics and user type classification. No insight should query raw `events` directly.

**View columns:** `distinct_id`, `week`, `first_week`, `is_new`, `weeks_seen`, `has_ai`, `file_saves`, `file_creates`, `editor_opens`, `workspace_opens`, `searches`, `terminal_events`, `total_events`, `user_type`

**User type classification:**
- `ai_user` -- any AI event that week (see AI events list below)
- `real_editor` -- 3+ file saves OR 2+ file creates OR 2+ searches OR 2+ terminal events
- `light_user` -- some activity but below real_editor thresholds
- `ghost` -- zero file saves, zero file creates, <=2 editor opens, <=1 workspace opens, zero searches, zero terminal events

**AI events used for classification (`has_ai` flag):**
- Desktop: `ai_message_sent`, `ai_message_queued`, `ai_response_received`, `ai_stream_interrupted`, `ai_request_failed`, `ai_session_resumed`, `create_ai_session`, `cancel_ai_request`, `claude_code_session_started`, `codex_session_started`, `blitz_created`, `ai_diff_accepted`, `ai_diff_rejected`, `tool_permission_responded`, `ask_user_question_answered`, `ask_user_question_cancelled`, `exit_plan_mode_response`, `git_commit_proposal_response`, `ai_effort_level_changed`, `ai_thinking_mode_changed`
- Voice: `voice_session_started`, `voice_prompt_submitted`
- Mobile: `mobile_ai_message_sent`, `mobile_session_created`, `mobile_ask_user_question_response`, `mobile_tool_permission_response`, `mobile_exit_plan_mode_response`, `mobile_git_commit_response`

**Intentionally excluded** (configuration/system events, not direct AI usage): `ai_provider_configured`, `ai_model_selected`, `check_claude_login_status`, `do_claude_code_login`, `mcp_server_added`, `agent_permissions_opened`, `trust_dialog_saved`, `worktree_created`

## Chart Rules

1. **Stacked bar charts only.** No line charts, no tables, no pie charts.
2. **Every chart must sum to 100%.** Each bar represents all users in the view for that week (or the relevant new/returning subset). Use percentage columns (e.g., `round(countIf(...) * 100.0 / count(), 1)`).
3. **All users must be represented.** The four segments (ai_user, real_editor, light_user, ghost) must all appear as series. No segment may be omitted.

## New vs Returning Split

The only allowed exception to "one insight covers all users" is splitting into New and Returning:

- **New users:** `WHERE is_new = 1` -- users whose first week matches the current week
- **Returning users:** `WHERE is_new = 0` -- users who were first seen in a prior week

When split, insight names MUST include the suffix:
- `(NEW USERS ONLY)`
- `(RETURNING USERS ONLY)`

## Example Queries

**All users by segment:**
```sql
SELECT week,
  round(countIf(user_type = 'ai_user') * 100.0 / count(), 1) as ai_user,
  round(countIf(user_type = 'real_editor') * 100.0 / count(), 1) as real_editor,
  round(countIf(user_type = 'light_user') * 100.0 / count(), 1) as light_user,
  round(countIf(user_type = 'ghost') * 100.0 / count(), 1) as ghost
FROM WEEKLY_USERS_BASE_VIEW
GROUP BY week
ORDER BY week
```

**New users only:**
```sql
SELECT week,
  round(countIf(user_type = 'ai_user') * 100.0 / count(), 1) as ai_user,
  round(countIf(user_type = 'real_editor') * 100.0 / count(), 1) as real_editor,
  round(countIf(user_type = 'light_user') * 100.0 / count(), 1) as light_user,
  round(countIf(user_type = 'ghost') * 100.0 / count(), 1) as ghost
FROM WEEKLY_USERS_BASE_VIEW
WHERE is_new = 1
GROUP BY week
ORDER BY week
```

**Returning users only:**
```sql
SELECT week,
  round(countIf(user_type = 'ai_user') * 100.0 / count(), 1) as ai_user,
  round(countIf(user_type = 'real_editor') * 100.0 / count(), 1) as real_editor,
  round(countIf(user_type = 'light_user') * 100.0 / count(), 1) as light_user,
  round(countIf(user_type = 'ghost') * 100.0 / count(), 1) as ghost
FROM WEEKLY_USERS_BASE_VIEW
WHERE is_new = 0
GROUP BY week
ORDER BY week
```

## PostHog Resources

- **Dashboard:** [Weeklys](https://us.posthog.com/project/234047/dashboard/1331038) (ID: 1331038)
- **Base view:** `WEEKLY_USERS_BASE_VIEW` (created in PostHog SQL editor)
- **Reference insight:** [BASE: WEEKLY_USERS_BASE_VIEW query](https://us.posthog.com/project/234047/insights/Wnw24Y2z) (Wnw24Y2z) -- keep in sync with actual view
- **Test account exclusion:** Built into the view via cohort ID 200405
