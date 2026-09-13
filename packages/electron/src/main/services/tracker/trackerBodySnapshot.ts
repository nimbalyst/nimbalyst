/** Shared initial-body cache write for UI and MCP creation transactions. */
export function initialTrackerBodyCache(itemId: string, contentJson: string) {
  return {
    sql: 'INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at) VALUES ($1, $2, $3, NOW())',
    params: [itemId, 1, contentJson],
  };
}
