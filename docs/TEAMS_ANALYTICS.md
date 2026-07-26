# Nimbalyst Teams Analytics Runbook

This runbook defines the saved PostHog assets for Nimbalyst Teams. Create them only after a public build has emitted the contract events; until then, use development traffic only to validate schemas and keep production dashboards release-gated.

All production insights must exclude dev users with `is_dev_user != true`. Default breakdowns are `nimbalyst_version`, platform, `surface`, and the event-specific low-cardinality properties. Do not add identifiers or PostHog Groups for organizations, projects, documents, rooms, or members.

## Dashboard 1: Teams acquisition and activation

Create a unique-users funnel with a 30-day conversion window:

1. `team_surface_opened`, or `content_mode_switched` where `toMode=collab`
2. `team_organization_created` or `team_invitation_accepted`
3. `team_project_added`
4. `collab_document_created`, `collab_document_first_edited`, or `tracker_item_mutated` where `collaborationScope=shared`

Add separate trends for organization setup failures by `operation` and `errorCategory`, and activation by `entryPoint`.

## Dashboard 2: Team growth and administration

Add weekly unique-user trends for `team_invitation_sent`, `team_invitation_accepted`, `team_member_role_changed`, `team_member_removed`, `team_project_added`, `team_project_access_changed`, `team_project_moved`, and `team_organization_merged`.

Break down only by role and bounded member/project-count buckets. Add an invitation sent-to-accepted funnel with a 30-day conversion window.

## Dashboard 3: Shared Docs engagement and retention

Add weekly unique-user trends for `collab_home_opened`, `collab_home_searched`, `collab_document_created`, `collab_document_opened`, `collab_document_first_edited`, and `collab_document_action`.

Add:

- a create/open-to-first-edit funnel;
- document creation by `source` and `documentType`;
- explicit opens by `source`, excluding `source=restart_restore` from primary engagement;
- Share to Team outcomes from `collab_share_asset_migration_completed`;
- weekly and monthly returning-user retention anchored on `collab_document_first_edited`.

## Dashboard 4: Shared tracker engagement

Add weekly unique-user trends for `tracker_item_clicked`, `tracker_table_sort`, `tracker_item_mutated`, and `tracker_item_scope_changed`.

Primary activation and retention insights filter `tracker_item_mutated` to `collaborationScope=shared`. Break down by `action`, `actorType`, `trackerType`, and `view`. Compare shared, personal, mixed, and unknown scope only in secondary adoption insights.

Read `action=field_changed` as "this item was edited at least once in a 10-minute window", not as an edit count — it is throttled per item so a typing session cannot flood the event. `created`, `status_changed`, `assigned`, `commented`, and `deleted` are unthrottled and are the right basis for volume counts. Tracker body edits are deliberately not instrumented; use `collab_document_first_edited` for editing intent.

## Dashboard 5: Collaboration reliability

Create attempt-level trends from `collab_sync_attempt_completed`:

- success, offline-ready, and failed rate by `resourceType`;
- failure breakdown by `errorCategory`;
- reconnect performance by `connectionPath`;
- outcome by `encryptionMode`, `durationCategory`, and `retryCountBucket`.

Add replay/migration/rejection trends for `collab_outbox_replay_completed`, `collab_share_asset_migration_completed`, `tracker_mutation_rejected`, and `collab_server_mutation_rejected`.

Client telemetry is not a substitute for Cloudflare logs or Durable Object metrics. It measures anonymous client-observed outcomes, not room-level incidents or exact server request traces.

`collab_sync_attempt_completed` is capped at one event per resource per 60 seconds and `collab_outbox_replay_completed` at one per document per 5 minutes, so a client stuck in a reconnect loop is visible as a sustained low rate rather than a spike. Both caps apply to successes and failures alike, so failure *rates* remain valid; absolute attempt *counts* are a lower bound and should not be read as connection volume.

## Alerts

Create four PostHog alerts after the first public schema validation:

1. Document sync failed rate exceeds 5% over 60 minutes with at least 20 attempts.
2. Tracker sync failed rate exceeds 5% over 60 minutes with at least 20 attempts.
3. Shared mutation rejections exceed 10 events over 30 minutes.
4. Share to Team failed or partial outcomes exceed 10% over 24 hours with at least 20 migrations.

Route alerts to the existing product reliability destination. Alert thresholds are starting values; review after 14 days of non-dev production traffic and record any threshold changes in this file.

## Release verification

After the first public build:

1. Confirm every new event appears with only allowlisted properties.
2. Inspect samples for raw paths, URLs, emails, identifiers, titles, names, git remotes, errors, content, and exact unbucketed values.
3. Create the five dashboards and four alerts above.
4. Record saved PostHog asset links in this section.
5. Review the first 14 days for unknown-category rates, duplicate attempt events, restart-restore inflation, and sparse or unused events.

Dashboard links: pending public event availability.

Alert links: pending public event availability.
