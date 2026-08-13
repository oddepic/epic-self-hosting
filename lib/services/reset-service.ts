import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, malTokens, playbackHistory, seasons, sessions, trackPreferences, users } from "../db/schema";
import type { JellyfinClient, SonarrClient } from "../integrations/types";

const DB_TABLES = [
  "users",
  "sessions",
  "animes",
  "seasons",
  "episodes",
  "playback_history",
  "track_preferences",
  "mal_tokens",
] as const;

export interface ResetResult {
  sonarr: { success: boolean; seriesDeleted: number };
  jellyfin: { success: boolean; itemsDeleted: number };
  db: { success: boolean; tables: Record<string, number> };
}

export class ResetService {
  constructor(
    private readonly db: Db,
    private readonly jellyfin: JellyfinClient,
    private readonly sonarr: SonarrClient,
  ) {}

  async reset(): Promise<ResetResult> {
    const sonarr = { success: true, seriesDeleted: 0 };
    try {
      const series = await this.sonarr.getSeries();
      sonarr.seriesDeleted = series.length;
      for (const s of series) {
        try {
          await this.sonarr.deleteSeries(s.id, true);
        } catch {
          // Sonarr can return 500 after the series is already removed; treat as done.
        }
      }
    } catch {
      sonarr.success = false;
    }

    const jellyfin = { success: true, itemsDeleted: 0 };
    try {
      const itemIds = await this.jellyfin.listAllItemIds();
      jellyfin.itemsDeleted = itemIds.length;
      for (const id of itemIds) {
        try {
          await this.jellyfin.deleteItem(id);
        } catch {
          // Best-effort; the library refresh cleans up stragglers.
        }
      }
      await this.jellyfin.refreshLibrary();
    } catch {
      jellyfin.success = false;
    }

    const db = { success: true, tables: {} as Record<string, number> };
    try {
      this.db.transaction((tx) => {
        tx.delete(playbackHistory).run();
        tx.delete(trackPreferences).run();
        tx.delete(malTokens).run();
        tx.delete(sessions).run();
        tx.delete(episodes).run();
        tx.delete(seasons).run();
        tx.delete(animes).run();
        tx.delete(users).run();
        tx.run(sql`DELETE FROM sqlite_sequence`);
      });
      for (const table of DB_TABLES) {
        const row = this.db.get<{ n: number }>(sql`SELECT count(*) AS n FROM ${sql.raw(table)}`);
        db.tables[table] = row?.n ?? 0;
      }
    } catch {
      db.success = false;
    }

    return { sonarr, jellyfin, db };
  }
}
