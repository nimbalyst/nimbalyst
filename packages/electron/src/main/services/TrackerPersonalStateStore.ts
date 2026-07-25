/** Local persistence for identity-scoped tracker favorites and genuine opens. */

type DatabaseLike = {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type EnsureReady = () => Promise<void>;

export interface TrackerPersonalStateRow {
  userEmail: string;
  scope: string;
  itemId: string;
  isFavorite: boolean;
  favoriteUpdatedAt: number;
  lastOpenedAt: number | null;
  /** Epoch ms until which this user's inbox hides the item; null = not snoozed. */
  snoozedUntil: number | null;
  updatedAt: number;
}

export interface SetTrackerFavoriteInput {
  userEmail: string;
  scope: string;
  itemId: string;
  isFavorite: boolean;
  favoriteUpdatedAt: number;
}

export interface RecordTrackerOpenedInput {
  userEmail: string;
  scope: string;
  itemId: string;
  lastOpenedAt: number;
}

export interface SetTrackerSnoozeInput {
  userEmail: string;
  scope: string;
  itemId: string;
  /** Epoch ms deadline, or null to un-snooze. */
  snoozedUntil: number | null;
  /** Wall-clock of the action, for LWW against a concurrent device. */
  updatedAt: number;
}

interface DbRow {
  user_email: string;
  scope: string;
  item_id: string;
  is_favorite: boolean | number;
  favorite_updated_at: number | string;
  last_opened_at: number | string | null;
  snoozed_until: number | string | null;
  updated_at: number | string;
}

function mapRow(row: DbRow): TrackerPersonalStateRow {
  return {
    userEmail: row.user_email,
    scope: row.scope,
    itemId: row.item_id,
    isFavorite: row.is_favorite === true || row.is_favorite === 1,
    favoriteUpdatedAt: Number(row.favorite_updated_at),
    lastOpenedAt: row.last_opened_at == null ? null : Number(row.last_opened_at),
    snoozedUntil: row.snoozed_until == null ? null : Number(row.snoozed_until),
    updatedAt: Number(row.updated_at),
  };
}

export function createTrackerPersonalStateStore(db: DatabaseLike, ensureDbReady?: EnsureReady) {
  const ready = async () => { await ensureDbReady?.(); };

  async function getOne(userEmail: string, scope: string, itemId: string): Promise<TrackerPersonalStateRow | null> {
    const { rows } = await db.query<DbRow>(
      `SELECT * FROM tracker_personal_state
       WHERE user_email = $1 AND scope = $2 AND item_id = $3`,
      [userEmail, scope, itemId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  return {
    async getForScope(userEmail: string, scope: string): Promise<TrackerPersonalStateRow[]> {
      await ready();
      const { rows } = await db.query<DbRow>(
        `SELECT * FROM tracker_personal_state WHERE user_email = $1 AND scope = $2`,
        [userEmail, scope],
      );
      return rows.map(mapRow);
    },

    async setFavorite(input: SetTrackerFavoriteInput): Promise<TrackerPersonalStateRow | null> {
      await ready();
      const existing = await getOne(input.userEmail, input.scope, input.itemId);
      if (existing && input.favoriteUpdatedAt <= existing.favoriteUpdatedAt) return null;

      await db.query(
        `INSERT INTO tracker_personal_state
           (user_email, scope, item_id, is_favorite, favorite_updated_at, last_opened_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $5)
         ON CONFLICT (user_email, scope, item_id) DO UPDATE SET
           is_favorite = EXCLUDED.is_favorite,
           favorite_updated_at = EXCLUDED.favorite_updated_at,
           updated_at = CASE
             WHEN tracker_personal_state.updated_at > EXCLUDED.updated_at
             THEN tracker_personal_state.updated_at ELSE EXCLUDED.updated_at END
         WHERE EXCLUDED.favorite_updated_at > tracker_personal_state.favorite_updated_at`,
        [input.userEmail, input.scope, input.itemId, input.isFavorite, input.favoriteUpdatedAt],
      );
      return getOne(input.userEmail, input.scope, input.itemId);
    },

    async recordOpened(input: RecordTrackerOpenedInput): Promise<TrackerPersonalStateRow | null> {
      await ready();
      const existing = await getOne(input.userEmail, input.scope, input.itemId);
      if (existing?.lastOpenedAt != null && input.lastOpenedAt <= existing.lastOpenedAt) return null;

      await db.query(
        `INSERT INTO tracker_personal_state
           (user_email, scope, item_id, is_favorite, favorite_updated_at, last_opened_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, $5, $5)
         ON CONFLICT (user_email, scope, item_id) DO UPDATE SET
           last_opened_at = EXCLUDED.last_opened_at,
           updated_at = CASE
             WHEN tracker_personal_state.updated_at > EXCLUDED.updated_at
             THEN tracker_personal_state.updated_at ELSE EXCLUDED.updated_at END
         WHERE tracker_personal_state.last_opened_at IS NULL
            OR EXCLUDED.last_opened_at > tracker_personal_state.last_opened_at`,
        [input.userEmail, input.scope, input.itemId, false, input.lastOpenedAt],
      );
      return getOne(input.userEmail, input.scope, input.itemId);
    },

    /**
     * Snooze (or un-snooze) an item for this user's inbox. Last write wins on
     * `updated_at` so a stale reply from another device can't resurrect an
     * already-cleared snooze.
     */
    async setSnooze(input: SetTrackerSnoozeInput): Promise<TrackerPersonalStateRow | null> {
      await ready();
      const existing = await getOne(input.userEmail, input.scope, input.itemId);
      if (existing && input.updatedAt < existing.updatedAt) return null;

      await db.query(
        `INSERT INTO tracker_personal_state
           (user_email, scope, item_id, is_favorite, favorite_updated_at, last_opened_at, snoozed_until, updated_at)
         VALUES ($1, $2, $3, $4, 0, NULL, $5, $6)
         ON CONFLICT (user_email, scope, item_id) DO UPDATE SET
           snoozed_until = EXCLUDED.snoozed_until,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at >= tracker_personal_state.updated_at`,
        [input.userEmail, input.scope, input.itemId, false, input.snoozedUntil, input.updatedAt],
      );
      return getOne(input.userEmail, input.scope, input.itemId);
    },
  };
}

export type TrackerPersonalStateStore = ReturnType<typeof createTrackerPersonalStateStore>;
