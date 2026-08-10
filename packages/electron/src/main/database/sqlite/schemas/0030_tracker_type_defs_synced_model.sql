-- The last shared schema definition this workspace projected onto its
-- `.nimbalyst/trackers/<type>.yaml` file.
--
-- Team schema sync makes the shared definition authoritative, but the YAML dir
-- stays editable: a hand edit must still reach teammates. Distinguishing "the
-- user edited this file" from "this file predates the team's definition" needs a
-- record of what we last wrote to disk. NULL means the shared definition has
-- never been projected onto the file, so whatever is on disk is presumed stale
-- and must never overwrite the shared model.
--
-- JSON TEXT, like `model`, so it reads identically on both backends.

ALTER TABLE tracker_type_defs ADD COLUMN synced_model TEXT;
