import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes, users, playbackHistory } from "../db/schema";
import { completeEpisode, completeEpisodeThrough, setWatchedThrough, unwatchEpisode, unwatchThrough } from "./episode-service";

describe("completeEpisode", () => {
  let db: Db;
  let episodeId: number;
  let userId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    const user = db
      .insert(users)
      .values({ username: "admin", passwordHash: "x", preferences: {}, createdAt: 1 })
      .returning()
      .get();
    userId = user.id;
    const anime = db
      .insert(animes)
      .values({ anilistId: 1, titleRomaji: "Any Anime", status: "watching", createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const season = db
      .insert(seasons)
      .values({ animeId: anime.id, number: 1 })
      .returning()
      .get();
    episodeId = db
      .insert(episodes)
      .values({ seasonId: season.id, episodeNumber: 1, progressSeconds: 400, durationSeconds: 1420 })
      .returning()
      .get().id;
  });

  it("marks the episode watched, clears progress, and writes a completed history row", () => {
    completeEpisode(db, { episodeId, userId, positionSeconds: 1402, now: () => 1000 });

    const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(episode!.watched).toBe(true);
    expect(episode!.progressSeconds).toBe(0);

    const history = db.select().from(playbackHistory).all();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      episodeId,
      userId,
      timestamp: 1000,
      positionSeconds: 1402,
      completed: true,
    });
  });

  it("overwrites the duration when provided and keeps it when not", () => {
    completeEpisode(db, { episodeId, userId, positionSeconds: 100, durationSeconds: 1500, now: () => 1 });
    let episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(episode!.durationSeconds).toBe(1500);

    completeEpisode(db, { episodeId, userId, positionSeconds: 100, now: () => 2 });
    episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(episode!.durationSeconds).toBe(1500);
  });

  it("bumps the entry watched counter once per newly watched episode", () => {
    const anime = db.select().from(animes).where(eq(animes.id, 1)).get();
    completeEpisode(db, { episodeId, userId, positionSeconds: 100, now: () => 1 });
    completeEpisode(db, { episodeId, userId, positionSeconds: 100, now: () => 2 });
    expect(db.select().from(animes).where(eq(animes.id, 1)).get()!.watchedEpisodes).toBe(1);

    unwatchEpisode(db, { episodeId });
    expect(db.select().from(animes).where(eq(animes.id, 1)).get()!.watchedEpisodes).toBe(0);
    expect(anime!.watchedEpisodes).toBe(0);
  });
});

describe("completeEpisodeThrough", () => {
  let db: Db;
  let userId: number;
  let animeId: number;
  let s1: number;
  let s2: number;
  let epIds: Record<string, number>;

  beforeEach(() => {
    db = createDb(":memory:");
    const user = db
      .insert(users)
      .values({ username: "admin", passwordHash: "x", preferences: {}, createdAt: 1 })
      .returning()
      .get();
    userId = user.id;
    animeId = db
      .insert(animes)
      .values({ anilistId: 1, titleRomaji: "Any Anime", status: "watching", createdAt: 1, updatedAt: 1 })
      .returning()
      .get().id;
    s1 = db.insert(seasons).values({ animeId, number: 1 }).returning().get().id;
    s2 = db.insert(seasons).values({ animeId, number: 2 }).returning().get().id;
    epIds = {};
    for (const [seasonId, number] of [[s1, 1], [s1, 2], [s2, 1]] as const) {
      const key = `${number === 1 && seasonId === s1 ? "s1e1" : number === 2 ? "s1e2" : "s2e1"}`;
      epIds[key] = db
        .insert(episodes)
        .values({ seasonId, episodeNumber: number, durationSeconds: 1420, progressSeconds: 0 })
        .returning()
        .get().id;
    }
  });

  it("marks the target and all earlier episodes watched", () => {
    const completed = completeEpisodeThrough(db, { episodeId: epIds.s1e2!, userId, now: () => 1000 });

    expect(completed).toBe(2);
    const watched = db.select().from(episodes).all().filter((e) => e.watched).length;
    expect(watched).toBe(2);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s2e1!)).get()!.watched).toBe(false);
    expect(db.select().from(playbackHistory).all()).toHaveLength(2);
  });

  it("marks only the target season, never earlier seasons", () => {
    const completed = completeEpisodeThrough(db, { episodeId: epIds.s2e1!, userId, now: () => 1000 });

    expect(completed).toBe(1);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s2e1!)).get()!.watched).toBe(true);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e1!)).get()!.watched).toBe(false);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e2!)).get()!.watched).toBe(false);
  });

  it("returns zero for an unknown episode", () => {
    expect(completeEpisodeThrough(db, { episodeId: 999_999, userId, now: () => 1 })).toBe(0);
  });

  it("unwatches a single episode and removes its completion history", () => {
    completeEpisodeThrough(db, { episodeId: epIds.s1e2!, userId, now: () => 1000 });

    unwatchEpisode(db, { episodeId: epIds.s1e2! });

    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e2!)).get()!.watched).toBe(false);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e1!)).get()!.watched).toBe(true);
    expect(db.select().from(playbackHistory).all()).toHaveLength(1);
  });

  it("unwatches everything up to and including the target", () => {
    completeEpisodeThrough(db, { episodeId: epIds.s1e2!, userId, now: () => 1000 });

    const unmarked = unwatchThrough(db, { episodeId: epIds.s1e2! });

    expect(unmarked).toBe(2);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e1!)).get()!.watched).toBe(false);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e2!)).get()!.watched).toBe(false);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s2e1!)).get()!.watched).toBe(false);
  });

  it("sets the watched count to exactly the target episode within the season", () => {
    completeEpisodeThrough(db, { episodeId: epIds.s1e2!, userId, now: () => 1000 });

    const result = setWatchedThrough(db, { episodeId: epIds.s1e1!, userId, now: () => 2000 });

    expect(result).toEqual({ marked: 0, unmarked: 1 });
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e1!)).get()!.watched).toBe(true);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e2!)).get()!.watched).toBe(false);
    // A different season is never touched.
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s2e1!)).get()!.watched).toBe(false);
  });

  it("marks forward when the target is beyond the current watched count", () => {
    const result = setWatchedThrough(db, { episodeId: epIds.s1e2!, userId, now: () => 1000 });

    expect(result).toEqual({ marked: 2, unmarked: 0 });
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e1!)).get()!.watched).toBe(true);
    expect(db.select().from(episodes).where(eq(episodes.id, epIds.s1e2!)).get()!.watched).toBe(true);
  });
});
