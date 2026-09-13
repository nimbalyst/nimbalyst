-- Local creation receipts survive a lost IPC response without duplicating an item.
CREATE TABLE IF NOT EXISTS tracker_creation_receipts (
  item_id TEXT PRIMARY KEY REFERENCES tracker_items(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  publication_status TEXT NOT NULL,
  error TEXT,
  updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tracker_creation_workspace ON tracker_creation_receipts(workspace, publication_status);
