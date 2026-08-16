import { sql } from "drizzle-orm";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
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
  files: { success: boolean; empty: boolean };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove the contents of a directory but keep the directory itself.
 * The directory is recreated if it does not exist.
 */
async function emptyDirectory(rootFolder: string): Promise<boolean> {
  await mkdir(rootFolder, { recursive: true });
  const entries = await readdir(rootFolder);
  for (const entry of entries) {
    await rm(join(rootFolder, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  return true;
}

export class ResetService {
  constructor(
    private readonly db: Db,
    private readonly jellyfin: JellyfinClient,
    private readonly sonarr: SonarrClient,
    private readonly rootFolder?: string,
    private readonly options: { settleDelayMs?: number } = {},
  ) {}

  async reset(): Promise<ResetResult> {
    const settleDelayMs = this.options.settleDelayMs ?? 250;

    const sonarr = { success: true, seriesDeleted: 0 };
    try {
      const series = await this.sonarr.getSeries();
      sonarr.seriesDeleted = series.length;
      for (const s of series) {
        try {
          // deleteFiles=false: remove the Sonarr series record only; the files
          // on disk are emptied separately (keeping the root directory).
          await this.sonarr.deleteSeries(s.id, false);
        } catch {
          // Sonarr can return 500 after the series is already removed; treat as done.
        }
      }
    } catch {
      sonarr.success = false;
    }

    // Delete only the TOP-LEVEL series in Jellyfin (their episodes and
    // seasons cascade). Rapidly deleting every item one-by-one while the
    // file watcher churns has repeatedly crashed Jellyfin 10.11.11 with a
    // native stack overflow (0xc00000fd) — keep this part small and spaced.
    const jellyfin = { success: true, itemsDeleted: 0 };
    try {
      const jellyfinSeries = await this.jellyfin.getSeries();
      jellyfin.itemsDeleted = jellyfinSeries.length;
      for (const s of jellyfinSeries) {
        try {
          await this.jellyfin.deleteItem(s.id);
        } catch {
          // Best-effort; the library refresh cleans up stragglers.
        }
        if (settleDelayMs > 0) await sleep(settleDelayMs);
      }
    } catch {
      jellyfin.success = false;
    }

    // Empty the media folder AFTER the items are gone: the library watcher
    // then has nothing left to reconcile for each deleted file.
    const files = { success: true, empty: false };
    if (this.rootFolder) {
      try {
        await emptyDirectory(this.rootFolder);
        files.empty = true;
      } catch {
        files.success = false;
      }
    }

    try {
      if (settleDelayMs > 0) await sleep(settleDelayMs);
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

    return { sonarr, jellyfin, db, files };
  }
}
