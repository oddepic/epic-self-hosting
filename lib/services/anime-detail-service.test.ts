import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { AnimeDetailService } from "./anime-detail-service";

function seedAnime(db: Db, overrides: Partial<typeof animes.$inferInsert> = {}): number {
  return db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      titleRomaji: "Any Anime",
      titleEnglish: "Any Anime",
      status: "watching",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .returning()
    .get().id;
}

function seedSeason(db: Db, animeId: number, number: number): number {
  return db.insert(seasons).values({ animeId, number }).returning().get().id;
}

function seedEpisode(
  db: Db,
  seasonId: number,
  episodeNumber: number,
  overrides: Partial<typeof episodes.$inferInsert> = {},
): number {
  return db
    .insert(episodes)
    .values({
      seasonId,
      episodeNumber,
      title: `Episode ${episodeNumber}`,
      thumbnailUrl: `http://x/thumb-${episodeNumber}`,
      durationSeconds: 1420,
      progressSeconds: 0,
      available: true,
      ...overrides,
    })
    .returning()
    .get().id;
}

describe("AnimeDetailService.getDetail", () => {
  let db: Db;
  let service: AnimeDetailService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new AnimeDetailService(db);
  });

  it("returns the anime, seasons with watched counts, and episodes of the requested season", () => {
    const animeId = seedAnime(db);
    const s1 = seedSeason(db, animeId, 1);
    seedEpisode(db, s1, 1, { watched: true });
    seedEpisode(db, s1, 2, { watched: true });
    seedEpisode(db, s1, 3);
    const s2 = seedSeason(db, animeId, 2);
    seedEpisode(db, s2, 1);
    seedEpisode(db, s2, 2);

    const detail = service.getDetail(animeId, 2)!;

    expect(detail.anime.id).toBe(animeId);
    expect(detail.seasons).toEqual([
      { number: 1, watchedCount: 2, totalCount: 3 },
      { number: 2, watchedCount: 0, totalCount: 2 },
    ]);
    expect(detail.episodes).toHaveLength(2);
    expect(detail.episodes[0]).toMatchObject({ episodeNumber: 1, title: "Episode 1" });
    expect(detail.episodes[1]).toMatchObject({ episodeNumber: 2, watched: false, available: true });
  });

  it("defaults to the season of the resumable episode when no season is given", () => {
    const animeId = seedAnime(db);
    const s1 = seedSeason(db, animeId, 1);
    seedEpisode(db, s1, 1);
    const s2 = seedSeason(db, animeId, 2);
    seedEpisode(db, s2, 1);
    seedEpisode(db, s2, 2, { progressSeconds: 500 });

    const detail = service.getDetail(animeId)!;

    expect(detail.seasons[1]!.number).toBe(2);
    expect(detail.episodes).toHaveLength(2);
  });

  it("defaults to the first season when nothing is resumable", () => {
    const animeId = seedAnime(db);
    const s1 = seedSeason(db, animeId, 1);
    seedEpisode(db, s1, 1);
    const s2 = seedSeason(db, animeId, 2);
    seedEpisode(db, s2, 1);

    const detail = service.getDetail(animeId)!;

    expect(detail.episodes[0]!.episodeNumber).toBe(1);
  });

  it("picks the first resumable episode across seasons as resume", () => {
    const animeId = seedAnime(db);
    const s1 = seedSeason(db, animeId, 1);
    seedEpisode(db, s1, 1, { progressSeconds: 200 });
    seedEpisode(db, s1, 2, { watched: true, progressSeconds: 0 });
    const s2 = seedSeason(db, animeId, 2);
    seedEpisode(db, s2, 1, { progressSeconds: 300 });

    const detail = service.getDetail(animeId)!;

    expect(detail.resume).toEqual({ episodeId: expect.any(Number), seasonNumber: 1, episodeNumber: 1 });
  });

  it("returns no resume when every episode is watched or untouched", () => {
    const animeId = seedAnime(db);
    const s1 = seedSeason(db, animeId, 1);
    seedEpisode(db, s1, 1, { watched: true });
    seedEpisode(db, s1, 2);

    const detail = service.getDetail(animeId)!;

    expect(detail.resume).toBeNull();
  });

  it("returns the first available episode as start when nothing is resumable", () => {
    const animeId = seedAnime(db);
    const s1 = seedSeason(db, animeId, 1);
    seedEpisode(db, s1, 1, { available: false });
    seedEpisode(db, s1, 2, { available: true });

    const detail = service.getDetail(animeId)!;

    expect(detail.start).toEqual({ episodeId: expect.any(Number), seasonNumber: 1, episodeNumber: 2 });
  });

  it("reports fullyDownloaded only when every episode is available", () => {
    const animeId = seedAnime(db);
    const s1 = seedSeason(db, animeId, 1);
    seedEpisode(db, s1, 1, { available: true });
    seedEpisode(db, s1, 2, { available: false });

    expect(service.getDetail(animeId)!.fullyDownloaded).toBe(false);

    db.update(episodes).set({ available: true }).where(eq(episodes.seasonId, s1)).run();
    expect(service.getDetail(animeId)!.fullyDownloaded).toBe(true);
  });

  it("is not fullyDownloaded when there are no episodes", () => {
    const animeId = seedAnime(db);
    expect(service.getDetail(animeId)!.fullyDownloaded).toBe(false);
  });

  it("returns null for an unknown anime", () => {
    expect(service.getDetail(999_999)).toBeNull();
  });

  it("handles an anime with no seasons", () => {
    const animeId = seedAnime(db);
    const detail = service.getDetail(animeId)!;
    expect(detail.seasons).toEqual([]);
    expect(detail.episodes).toEqual([]);
    expect(detail.resume).toBeNull();
    expect(detail.start).toBeNull();
  });
});
