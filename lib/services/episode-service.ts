import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, playbackHistory, seasons } from "../db/schema";

export function formatEpisodeLabel(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

// Entry-level watched counter: MAL counts episodes across ALL seasons of a
// single entry (One Piece, Naruto…), so the per-season flags alone can't
// drive the MAL progress. The anime row's watchedEpisodes is the source of
// truth; every flag mutation adjusts it by the delta of newly/removed marks.
function bumpWatchedCounter(db: Db, animeId: number, delta: number): void {
  const anime = db.select().from(animes).where(eq(animes.id, animeId)).get();
  if (!anime) return;
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
  if (wasWatched && animeId != null) bumpWatchedCounter(db, animeId, -1);
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
  if (unmarked > 0) bumpWatchedCounter(db, targetSeason.animeId, -unmarked);
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
  if (!alreadyWatched && animeId != null) bumpWatchedCounter(db, animeId, 1);
}
