-- Per-tool usage counters. A counter table (not an event log): one row per
-- (tool_name, provider, project_path, day), incremented via UPSERT. Feeds two
-- consumers: local tip targeting (rolled up to mcp:<server> + built-in names)
-- and the AI Usage Report Tools tab (top tools, built-in vs MCP, over-time,
-- per-project). project_path/provider default to '' (never NULL) so the
-- composite PRIMARY KEY is valid and ON CONFLICT is well-defined on both
-- backends.

CREATE TABLE IF NOT EXISTS tool_usage_counters (
  tool_name    TEXT NOT NULL,
  mcp_server   TEXT,
  mcp_tool     TEXT,
  provider     TEXT NOT NULL DEFAULT '',
  project_path TEXT NOT NULL DEFAULT '',
  day          TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  error_count  INTEGER NOT NULL DEFAULT 0,
  first_used   TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used    TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tool_name, provider, project_path, day)
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_day ON tool_usage_counters (day);
CREATE INDEX IF NOT EXISTS idx_tool_usage_server ON tool_usage_counters (mcp_server);
