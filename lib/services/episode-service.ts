import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { episodes, playbackHistory, seasons } from "../db/schema";

export function formatEpisodeLabel(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

export interface CompleteEpisodeThroughInput {
  episodeId: number;
  userId: number;
  now: () => number;
}

export function unwatchEpisode(db: Db, input: { episodeId: number }): void {
  const episode = db.select().from(episodes).where(eq(episodes.id, input.episodeId)).get();
  if (!episode) return;
  db.transaction((tx) => {
    tx.update(episodes).set({ watched: false, progressSeconds: 0 }).where(eq(episodes.id, episode.id)).run();
    tx.delete(playbackHistory)
      .where(and(eq(playbackHistory.episodeId, episode.id), eq(playbackHistory.completed, true)))
      .run();
  });
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
        row.seasonNumber < targetSeason.number ||
        (row.seasonNumber === targetSeason.number && row.episode.episodeNumber <= target.episodeNumber),
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
  return unmarked;
}

export function completeEpisodeThrough(db: Db, input: CompleteEpisodeThroughInput): number {
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
  const toComplete = rows
    .filter(
      (row) =>
        row.seasonNumber < targetSeason.number ||
        (row.seasonNumber === targetSeason.number && row.episode.episodeNumber <= target.episodeNumber),
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

export interface CompleteEpisodeInput {
  episodeId: number;
  userId: number;
  positionSeconds: number;
  durationSeconds?: number;
  now: () => number;
}

export function completeEpisode(db: Db, input: CompleteEpisodeInput): void {
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
}
