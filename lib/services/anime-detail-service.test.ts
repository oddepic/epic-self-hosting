import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
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
    expect(detail.seasons.map((s) => ({ ...s, ownerSeasonId: expect.any(Number) }))).toEqual([
      { number: 1, watchedCount: 2, totalCount: 3, availableCount: 3, ownerAnimeId: animeId, isSpecials: false, year: null, ownerSeasonId: expect.any(Number) },
      { number: 2, watchedCount: 0, totalCount: 2, availableCount: 2, ownerAnimeId: animeId, isSpecials: false, year: null, ownerSeasonId: expect.any(Number) },
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

describe("AnimeDetailService.getDetail — franchise modal", () => {
  let db: Db;
  let service: AnimeDetailService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new AnimeDetailService(db);
  });

  function seedEntry(
    overrides: Partial<typeof animes.$inferInsert> & { sonarrId?: number; seasonYear?: number } = {},
  ): number {
    return seedAnime(db, overrides);
  }

  // Rascal-shaped franchise: one Sonarr series, two entries, duplicated
  // seasons under each entry. S1 premiered 2018 (13 eps), S2 in 2025.
  function seedRascalFranchise(): { s1: number; clickedNew: number; clickedOld: number; s2: number } {
    const old = seedEntry({ sonarrId: 35, seasonYear: 2018, episodeCount: 13, titleRomaji: "Any Anime (2018)" });
    const newEntry = seedEntry({ sonarrId: 35, seasonYear: 2025, episodeCount: 13, titleRomaji: "Any Anime (2025)" });
    // Both entries carry all three seasons (the duplication bug 06 describes),
    // and the sync year-stamps every member's seasons from Sonarr air dates.
    const seasonIds: Record<number, { s1: number; s2: number }> = {};
    for (const animeId of [old, newEntry]) {
      seedSeason(db, animeId, 0);
      const s1 = seedSeason(db, animeId, 1);
      const s2 = seedSeason(db, animeId, 2);
      db.update(seasons).set({ year: 2018 }).where(eq(seasons.id, s1)).run();
      db.update(seasons).set({ year: 2025 }).where(eq(seasons.id, s2)).run();
      seasonIds[animeId] = { s1, s2 };
      if (animeId === old) {
        seedEpisode(db, s1, 1, { available: true });
      }
    }
    return { s1: seasonIds[old]!.s1, clickedOld: old, clickedNew: newEntry, s2: seasonIds[newEntry]!.s2 };
  }

  it("groups entries sharing a Sonarr series and dedupes the union of seasons", () => {
    const { clickedNew } = seedRascalFranchise();

    const detail = service.getDetail(clickedNew)!;

    expect(detail.members.map((m) => m.entrySeasonNumber)).toEqual([1, 2]);
    expect(detail.seasons.map((s) => s.number)).toEqual([0, 1, 2]);
    // Each season has exactly one canonical owner.
    expect(detail.seasons.find((s) => s.number === 1)!.ownerAnimeId).not.toBe(
      detail.seasons.find((s) => s.number === 2)!.ownerAnimeId,
    );
    // Specials have no mapped owner → earliest member carries them.
    expect(detail.seasons.find((s) => s.number === 0)!.isSpecials).toBe(true);
  });

  it("defaults to the clicked entry's own mapped season", () => {
    const { clickedNew } = seedRascalFranchise();

    const detail = service.getDetail(clickedNew)!;

    expect(detail.selectedSeasonNumber).toBe(2);
    expect(detail.selectedEntryId).toBe(clickedNew);
  });

  it("rebinds header controls to the entry owning the selected season", () => {
    const { clickedNew, clickedOld } = seedRascalFranchise();

    const viewingS1 = service.getDetail(clickedNew, 1)!;
    expect(viewingS1.selectedSeasonNumber).toBe(1);
    expect(viewingS1.selectedEntryId).toBe(clickedOld);

    const viewingS0 = service.getDetail(clickedNew, 0)!;
    // Specials belong to no entry — controls stay on the clicked one.
    expect(viewingS0.selectedEntryId).toBe(clickedNew);
  });

  it("episodes come from the owning member's rows", () => {
    const { clickedNew, clickedOld } = seedRascalFranchise();
    const oldS1 = db
      .select()
      .from(seasons)
      .where(and(eq(seasons.animeId, clickedOld), eq(seasons.number, 1)))
      .get()!;
    seedEpisode(db, oldS1.id, 7, { available: false });

    const viewingS1 = service.getDetail(clickedNew, 1)!;

    expect(viewingS1.episodes.some((e) => e.episodeNumber === 7)).toBe(true);
    // The duplicate rows under the other member are not mixed in.
    const newS1 = db
      .select()
      .from(seasons)
      .where(and(eq(seasons.animeId, clickedNew), eq(seasons.number, 1)))
      .get()!;
    const newRowIds = db.select({ id: episodes.id }).from(episodes).where(eq(episodes.seasonId, newS1.id)).all().map((r) => r.id);
    for (const row of viewingS1.episodes) {
      expect(newRowIds).not.toContain(row.id);
    }
  });

  it("resume/start search across every owned season of the franchise", () => {
    const { clickedNew, clickedOld } = seedRascalFranchise();
    const newS2 = db
      .select()
      .from(seasons)
      .where(and(eq(seasons.animeId, clickedNew), eq(seasons.number, 2)))
      .get()!;
    seedEpisode(db, newS2.id, 1, { progressSeconds: 300, available: true });

    const detail = service.getDetail(clickedNew, 1)!;

    expect(detail.resume).toMatchObject({ seasonNumber: 2, episodeNumber: 1 });
  });
});
