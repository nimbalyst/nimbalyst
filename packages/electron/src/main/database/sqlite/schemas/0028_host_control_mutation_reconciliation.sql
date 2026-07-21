-- Restart-safe ownership, leases, and application facts for the two host
-- control mutations. Receipt payloads are byte-capped by their stores.

ALTER TABLE queued_prompts ADD COLUMN interrupt_reservation_owner TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_lease_expires_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_operation_id TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE queued_prompts ADD COLUMN interrupt_application_state TEXT NOT NULL DEFAULT 'not_started'
  CHECK (interrupt_application_state IN ('not_started', 'unknown', 'not_applied', 'applied', 'legacy_unknown'));
ALTER TABLE queued_prompts ADD COLUMN interrupt_started_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_applied_at TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_application_receipt TEXT;
ALTER TABLE queued_prompts ADD COLUMN interrupt_cleanup_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (interrupt_cleanup_state IN ('pending', 'claimed', 'complete'));
ALTER TABLE queued_prompts ADD COLUMN interrupt_cleanup_fence INTEGER NOT NULL DEFAULT 0;

ALTER TABLE host_control_receipts ADD COLUMN reservation_owner TEXT;
ALTER TABLE host_control_receipts ADD COLUMN lease_expires_at TEXT;
ALTER TABLE host_control_receipts ADD COLUMN mutation_id TEXT;
ALTER TABLE host_control_receipts ADD COLUMN mutation_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE host_control_receipts ADD COLUMN mutation_state TEXT NOT NULL DEFAULT 'not_started'
  CHECK (mutation_state IN ('not_started', 'unknown', 'not_applied', 'applied', 'legacy_unknown'));
ALTER TABLE host_control_receipts ADD COLUMN mutation_started_at TEXT;
ALTER TABLE host_control_receipts ADD COLUMN mutation_applied_at TEXT;
ALTER TABLE host_control_receipts ADD COLUMN mutation_receipt TEXT;
ALTER TABLE host_control_receipts ADD COLUMN cleanup_prompt_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (cleanup_prompt_state IN ('pending', 'claimed', 'complete'));
ALTER TABLE host_control_receipts ADD COLUMN cleanup_prompt_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE host_control_receipts ADD COLUMN cleanup_attention_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (cleanup_attention_state IN ('pending', 'claimed', 'complete'));
ALTER TABLE host_control_receipts ADD COLUMN cleanup_attention_fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE host_control_receipts ADD COLUMN cleanup_attention_result TEXT
  CHECK (cleanup_attention_result IN ('settled', 'already_absent'));
ALTER TABLE host_control_receipts ADD COLUMN cleanup_terminal_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (cleanup_terminal_state IN ('pending', 'claimed', 'complete'));
ALTER TABLE host_control_receipts ADD COLUMN cleanup_terminal_fence INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS host_control_store_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL UNIQUE,
  authority_root TEXT NOT NULL
);

-- Repair7 could persist phase completion without the settlement result. A
-- nonterminal applied row must replay the guarded, idempotent attention phase
-- so the eventual receipt is conservative and truthful. Terminal rows retain
-- their already-persisted winner bytes.
UPDATE host_control_receipts
SET cleanup_attention_state = 'pending',
    cleanup_attention_fence = 0
WHERE state = 'reserved'
  AND mutation_state = 'applied'
  AND cleanup_attention_state = 'complete'
  AND cleanup_attention_result IS NULL;

-- A pre-0028 target without a terminal receipt may be either side of the
-- native-effect crash gap. It is never classified as safe-to-retry.
UPDATE queued_prompts
SET interrupt_operation_id = COALESCE(
      interrupt_operation_id,
      'legacy-interrupt:' || id || ':' || COALESCE(interrupt_target_generation, 'missing')
    ),
    interrupt_reservation_owner = COALESCE(interrupt_reservation_owner, 'legacy-orphan'),
    interrupt_lease_expires_at = COALESCE(interrupt_lease_expires_at, '1970-01-01T00:00:00.000Z'),
    interrupt_application_state = 'legacy_unknown'
WHERE interrupt_target_generation IS NOT NULL
  AND interrupt_receipt IS NULL
  AND interrupt_operation_id IS NULL
  AND interrupt_reservation_owner IS NULL
  AND interrupt_lease_expires_at IS NULL
  AND interrupt_fence = 0
  AND interrupt_application_state = 'not_started';

UPDATE queued_prompts
SET interrupt_operation_id = COALESCE(
      interrupt_operation_id,
      'legacy-interrupt:' || id || ':' || COALESCE(interrupt_target_generation, 'missing')
    )
WHERE interrupt_receipt IS NOT NULL
  AND interrupt_operation_id IS NULL;

-- Reserved 0027 rows had no ownership fields. Give them one expired,
-- fence-zero legacy acquisition so exactly one modern owner can reconcile
-- them without ever inferring that a native mutation is safe.
UPDATE host_control_receipts
SET mutation_id = COALESCE(mutation_id, 'legacy-host-mutation:' || id),
    reservation_owner = COALESCE(reservation_owner, 'legacy-orphan'),
    lease_expires_at = COALESCE(lease_expires_at, '1970-01-01T00:00:00.000Z'),
    mutation_state = 'legacy_unknown'
WHERE state = 'reserved'
  AND mutation_id IS NULL
  AND reservation_owner IS NULL
  AND lease_expires_at IS NULL
  AND mutation_fence = 0
  AND mutation_state = 'not_started';

UPDATE host_control_receipts
SET mutation_id = COALESCE(mutation_id, 'legacy-host-mutation:' || id)
WHERE state <> 'reserved'
  AND mutation_id IS NULL;
