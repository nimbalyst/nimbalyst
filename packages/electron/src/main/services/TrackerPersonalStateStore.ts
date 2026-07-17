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

interface DbRow {
  user_email: string;
  scope: string;
  item_id: string;
  is_favorite: boolean | number;
  favorite_updated_at: number | string;
  last_opened_at: number | string | null;
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
  };
}

export type TrackerPersonalStateStore = ReturnType<typeof createTrackerPersonalStateStore>;
