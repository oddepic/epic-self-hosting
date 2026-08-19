import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, playbackHistory, seasons } from "../db/schema";

export function formatEpisodeLabel(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

// An episode's position within its MAL entry — the scale the entry-level
// watchedEpisodes counter lives on. Two shapes exist:
//   - Entries that ARE one season (Rascal 2026, Re:ZERO 4th Season: the
//     entry's total equals the season's episode count) use the season-local
//     episode number. The franchise-wide absolute number is NOT used here —
//     Seishun Buta S2E11 is absolute 27 but episode 11 of its 13-ep entry.
//   - Whole-franchise entries (One Piece: entry total unknown) use the
//     absolute number, which is 1-based across the whole series.
// When neither applies the position is unknown and the caller falls back.
function episodeEntryPosition(
  db: Db,
  anime: { episodeCount: number | null },
  episode: typeof episodes.$inferSelect,
): number | null {
  if (anime.episodeCount != null) {
    const season = db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
    if (!season) return null;
    const count =
      db
        .select({ count: sql<number>`count(*)` })
        .from(episodes)
        .where(eq(episodes.seasonId, season.id))
        .get()?.count ?? 0;
    return count === anime.episodeCount ? episode.episodeNumber : null;
  }
  return episode.absoluteNumber;
}

// Entry-level watched counter: MAL counts watched episodes as a POSITION
// ("you've seen up to episode N of this entry"), never as a running total of
// per-episode marks. Marking forward therefore reconciles to the furthest
// entry position instead of adding 1 for every episode — otherwise episodes
// already counted by the MAL sync (e.g. watchedEpisodes = 11) would be counted
// a second time when their checkmarks are marked (11 + 11 = 22).
function bumpWatchedCounter(
  db: Db,
  animeId: number,
  episode: typeof episodes.$inferSelect | undefined,
  delta = 1,
): void {
  const anime = db.select().from(animes).where(eq(animes.id, animeId)).get();
  if (!anime) return;
  if (delta > 0 && episode) {
    const position = episodeEntryPosition(db, anime, episode);
    if (position != null) {
      db.update(animes)
        .set({ watchedEpisodes: Math.max(anime.watchedEpisodes, position) })
        .where(eq(animes.id, animeId))
        .run();
      return;
    }
  }
  const next = Math.max(0, anime.watchedEpisodes + delta);
  db.update(animes).set({ watchedEpisodes: next }).where(eq(animes.id, animeId)).run();
}

function animeIdOfEpisode(db: Db, episode: typeof episodes.$inferSelect): number | null {
  const season = db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
  return season?.animeId ?? null;
}

export interface CompleteEpisodeThroughInput {
  episodeId: number;
  userId: number;
  now: () => number;
}

export function unwatchEpisode(db: Db, input: { episodeId: number }): void {
  const episode = db.select().from(episodes).where(eq(episodes.id, input.episodeId)).get();
  if (!episode) return;
  const animeId = animeIdOfEpisode(db, episode);
  const wasWatched = episode.watched;
  db.transaction((tx) => {
    tx.update(episodes).set({ watched: false, progressSeconds: 0 }).where(eq(episodes.id, episode.id)).run();
    tx.delete(playbackHistory)
      .where(and(eq(playbackHistory.episodeId, episode.id), eq(playbackHistory.completed, true)))
      .run();
  });
  if (wasWatched && animeId != null) bumpWatchedCounter(db, animeId, episode, -1);
}

export function unwatchThrough(db: Db, input: { episodeId: number }): number {
  const target = db.select().from(episodes).where(eq(episodes.id, input.episodeId)).get();
  if (!target) return 0;
  const targetSeason = db.select().from(seasons).where(eq(seasons.id, target.seasonId)).get();
  if (!targetSeason) return 0;

  const rows = db
    .select({ episode: episodes, seasonNumber: seasons.number })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(eq(seasons.animeId, targetSeason.animeId))
    .all();
  const ids = rows
    .filter(
      (row) =>
        row.seasonNumber === targetSeason.number &&
        row.episode.episodeNumber <= target.episodeNumber,
    )
    .map((row) => row.episode.id);

  if (ids.length === 0) return 0;
  let unmarked = 0;
  db.transaction((tx) => {
    for (const id of ids) {
      const episode = tx.select().from(episodes).where(eq(episodes.id, id)).get();
      if (!episode || !episode.watched) continue;
      tx.update(episodes).set({ watched: false, progressSeconds: 0 }).where(eq(episodes.id, id)).run();
      tx.delete(playbackHistory)
        .where(and(eq(playbackHistory.episodeId, id), eq(playbackHistory.completed, true)))
        .run();
      unmarked++;
    }
  });
  if (unmarked > 0) bumpWatchedCounter(db, targetSeason.animeId, undefined, -unmarked);
  return unmarked;
}

export function completeEpisodeThrough(db: Db, input: CompleteEpisodeThroughInput): number {  const target = db.select().from(episodes).where(eq(episodes.id, input.episodeId)).get();
  if (!target) return 0;
  const targetSeason = db.select().from(seasons).where(eq(seasons.id, target.seasonId)).get();
  if (!targetSeason) return 0;

  const rows = db
    .select({ episode: episodes, seasonNumber: seasons.number })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(eq(seasons.animeId, targetSeason.animeId))
    .all();
  const toComplete = rows
    .filter(
      (row) =>
        row.seasonNumber === targetSeason.number &&
        row.episode.episodeNumber <= target.episodeNumber,
    )
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episode.episodeNumber - b.episode.episodeNumber);

  let completed = 0;
  db.transaction((tx) => {
    for (const row of toComplete) {
      if (row.episode.watched) continue;
      completeEpisode(tx, {
        episodeId: row.episode.id,
        userId: input.userId,
        positionSeconds: row.episode.durationSeconds ?? 0,
        now: input.now,
      });
      completed++;
    }
  });
  return completed;
}

export interface SetWatchedThroughResult {
  marked: number;
  unmarked: number;
}

// Set the watched count of a season to exactly N (the target episode's
// number): mark through N, unwatch everything beyond N in that season.
export function setWatchedThrough(db: Db, input: CompleteEpisodeThroughInput): SetWatchedThroughResult {
  const target = db.select().from(episodes).where(eq(episodes.id, input.episodeId)).get();
  if (!target) return { marked: 0, unmarked: 0 };
  const targetSeason = db.select().from(seasons).where(eq(seasons.id, target.seasonId)).get();
  if (!targetSeason) return { marked: 0, unmarked: 0 };

  const rows = db
    .select({ episode: episodes, seasonNumber: seasons.number })
    .from(episodes)
    .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
    .where(eq(seasons.animeId, targetSeason.animeId))
    .all();

  let marked = 0;
  let unmarked = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      if (row.seasonNumber !== targetSeason.number) continue;
      if (row.episode.episodeNumber <= target.episodeNumber) {
        if (row.episode.watched) continue;
        completeEpisode(tx, {
          episodeId: row.episode.id,
          userId: input.userId,
          positionSeconds: row.episode.durationSeconds ?? 0,
          now: input.now,
        });
        marked++;
      } else if (row.episode.watched) {
        tx.update(episodes).set({ watched: false, progressSeconds: 0 }).where(eq(episodes.id, row.episode.id)).run();
        tx.delete(playbackHistory)
          .where(and(eq(playbackHistory.episodeId, row.episode.id), eq(playbackHistory.completed, true)))
          .run();
        unmarked++;
      }
    }
  });
  return { marked, unmarked };
}

export interface CompleteEpisodeInput {
  episodeId: number;
  userId: number;
  positionSeconds: number;
  durationSeconds?: number;
  now: () => number;
}

export function completeEpisode(db: Db, input: CompleteEpisodeInput): void {
  const episode = db.select().from(episodes).where(eq(episodes.id, input.episodeId)).get();
  if (!episode) return;
  const animeId = animeIdOfEpisode(db, episode);
  const alreadyWatched = episode.watched;
  const changes: Partial<typeof episodes.$inferInsert> = { watched: true, progressSeconds: 0 };
  if (input.durationSeconds != null) {
    changes.durationSeconds = input.durationSeconds;
  }
  db.update(episodes).set(changes).where(eq(episodes.id, input.episodeId)).run();
  db.insert(playbackHistory).values({
    episodeId: input.episodeId,
    userId: input.userId,
    timestamp: input.now(),
    positionSeconds: input.positionSeconds,
    completed: true,
  }).run();
  if (!alreadyWatched && animeId != null) bumpWatchedCounter(db, animeId, episode);
}
