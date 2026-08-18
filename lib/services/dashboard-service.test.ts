import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { DashboardService } from "./dashboard-service";
import type { AniListClient } from "../integrations/types";

function seedAnime(
  db: Db,
  overrides: Partial<typeof animes.$inferInsert> = {},
): number {
  return db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      titleRomaji: "Any Anime",
      titleEnglish: "Any Anime",
      status: "watching",
      format: "TV",
      seasonYear: 2026,
      episodeCount: 24,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .returning()
    .get().id;
}

function seedEpisode(
  db: Db,
  animeId: number,
  seasonNumber: number,
  episodeNumber: number,
  overrides: Partial<typeof episodes.$inferInsert> = {},
): number {
  let season = db.select().from(seasons).where(eq(seasons.animeId, animeId)).get();
  if (!season) {
    season = db.insert(seasons).values({ animeId, number: seasonNumber }).returning().get();
  }
  return db
    .insert(episodes)
    .values({
      seasonId: season.id,
      episodeNumber,
      title: `Episode ${episodeNumber}`,
      durationSeconds: 1420,
      progressSeconds: 0,
      available: true,
      ...overrides,
    })
    .returning()
    .get().id;
}

function fakeAniList(schedule: { anilistId: number; airingAt: number | null; episode: number | null }[] = [], fail = false): AniListClient & { scheduleCalls: number[][] } {
  const scheduleCalls: number[][] = [];
  return {
    scheduleCalls,
    async search() {
      return [];
    },
    async getById() {
      return null;
    },
    async getByMalId() {
      return null;
    },
    async getByMalIds() {
      return [];
    },
    async getAiringSchedule(ids: number[]) {
      scheduleCalls.push(ids);
      if (fail) throw new Error("AniList responded 500");
      return schedule;
    },
  };
}

describe("DashboardService", () => {
  let db: Db;
  let service: DashboardService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new DashboardService(db);
  });

  describe("getContinueWatching", () => {
    it("orders by most recent watch activity first, then title and season/episode", () => {
      const animeB = seedAnime(db, { titleRomaji: "Beta", titleEnglish: "Beta", jellyfinId: "jf-b", lastWatchedAt: 900 });
      seedEpisode(db, animeB, 1, 1, { progressSeconds: 100 });
      seedEpisode(db, animeB, 1, 2, { progressSeconds: 50 });
      const animeA = seedAnime(db, { titleRomaji: "Alpha", titleEnglish: "Alpha", jellyfinId: "jf-a", lastWatchedAt: 100 });
      seedEpisode(db, animeA, 1, 1, { progressSeconds: 700 });

      const serviceWithUrl = new DashboardService(db, { jellyfinUrl: "http://jellyfin:8096" });
      const items = serviceWithUrl.getContinueWatching();

      expect(items.map((i) => i.animeTitle)).toEqual(["Beta", "Beta", "Alpha"]);
      expect(items[0]).toMatchObject({
        seasonNumber: 1,
        episodeNumber: 1,
        progressSeconds: 100,
        durationSeconds: 1420,
        label: "S01E01",
        episodeTitle: "Episode 1",
        backdropUrl: "http://jellyfin:8096/Items/jf-b/Images/Backdrop?maxWidth=1920&quality=90",
        logoUrl: "http://jellyfin:8096/Items/jf-b/Images/Logo?maxWidth=600",
      });
    });

    it("treats anime without activity as the least recent", () => {
      const recent = seedAnime(db, { titleRomaji: "Zeta", titleEnglish: "Zeta", lastWatchedAt: 500 });
      seedEpisode(db, recent, 1, 1, { progressSeconds: 100 });
      const noActivity = seedAnime(db, { titleRomaji: "Alpha", titleEnglish: "Alpha", lastWatchedAt: null });
      seedEpisode(db, noActivity, 1, 1, { progressSeconds: 100 });

      const items = service.getContinueWatching();

      expect(items.map((i) => i.animeTitle)).toEqual(["Zeta", "Alpha"]);
    });

    it("omits the backdrop when the anime has no Jellyfin item", () => {
      const animeId = seedAnime(db, { titleRomaji: "Gamma", jellyfinId: null });
      seedEpisode(db, animeId, 1, 1, { progressSeconds: 100 });

      const items = service.getContinueWatching();

      expect(items[0]!.backdropUrl).toBeNull();
    });

    it("excludes watched and untouched episodes", () => {
      const animeId = seedAnime(db);
      seedEpisode(db, animeId, 1, 1, { progressSeconds: 100 });
      seedEpisode(db, animeId, 1, 2, { watched: true, progressSeconds: 0 });
      seedEpisode(db, animeId, 1, 3, { progressSeconds: 0 });

      expect(service.getContinueWatching()).toHaveLength(1);
    });

    it("offers the next unwatched episode after finishing the previous one", () => {
      const animeId = seedAnime(db, { lastWatchedAt: 800 });
      seedEpisode(db, animeId, 1, 1, { watched: true, progressSeconds: 1420 });
      seedEpisode(db, animeId, 1, 2, { progressSeconds: 0 });

      const items = service.getContinueWatching();

      expect(items).toHaveLength(1);
      expect(items[0]!.episodeNumber).toBe(2);
      expect(items[0]!.progressSeconds).toBe(0);
    });

    it("does not offer an episode that is not downloaded yet", () => {
      const animeId = seedAnime(db, { lastWatchedAt: 800 });
      seedEpisode(db, animeId, 1, 1, { watched: true, progressSeconds: 1420 });
      seedEpisode(db, animeId, 1, 2, { available: false });

      expect(service.getContinueWatching()).toHaveLength(0);
    });

    it("does not show a hero for a fully completed anime", () => {
      const animeId = seedAnime(db, { lastWatchedAt: 800 });
      seedEpisode(db, animeId, 1, 1, { watched: true, progressSeconds: 1420 });
      seedEpisode(db, animeId, 1, 2, { watched: true, progressSeconds: 1420 });

      expect(service.getContinueWatching()).toHaveLength(0);
    });
  });

  describe("getWatching", () => {
    it("returns only watching-status anime ordered by last activity, most recent first", () => {
      const older = seedAnime(db, { titleRomaji: "Older", lastWatchedAt: 100 });
      const newer = seedAnime(db, { titleRomaji: "Newer", lastWatchedAt: 900 });
      seedAnime(db, { titleRomaji: "NotWatching", status: "plan_to_watch", lastWatchedAt: 500 });

      const items = service.getWatching();

      expect(items.map((a) => a.id)).toEqual([newer, older]);
      expect(items[0]).toMatchObject({ format: "TV", seasonYear: 2026, episodeCount: 24 });
    });

    it("puts anime without activity last and limits the list", () => {
      const active = seedAnime(db, { titleRomaji: "Zeta", lastWatchedAt: 100 });
      const noActivity = seedAnime(db, { titleRomaji: "Alpha", lastWatchedAt: null });
      const noActivity2 = seedAnime(db, { titleRomaji: "Beta", lastWatchedAt: null });

      const items = service.getWatching(2);

      expect(items).toHaveLength(2);
      expect(items[0]!.id).toBe(active);
      expect(items[1]!.id).toBe(noActivity);
      expect(items[1]!.titleRomaji).toBe("Alpha");
      expect(items[1]!.id).not.toBe(noActivity2);
    });
  });

  describe("getUpcoming", () => {
    it("returns animes with a future next episode, soonest first", async () => {
      seedAnime(db, { titleRomaji: "Later", nextEpisodeAt: 2_000 });
      seedAnime(db, { titleRomaji: "Sooner", nextEpisodeAt: 1_100 });
      seedAnime(db, { titleRomaji: "Past", nextEpisodeAt: 500 });
      seedAnime(db, { titleRomaji: "None", nextEpisodeAt: null });

      const items = await service.getUpcoming(10, 1_000);

      expect(items.map((a) => a.titleRomaji)).toEqual(["Sooner", "Later"]);
    });

    it("refreshes airing times via AniList and uses the fresh values", async () => {
      const animeId = seedAnime(db, { titleRomaji: "Airing", nextEpisodeAt: 500 });
      // The fake simulates the client's output, which is already in ms.
      const anilist = fakeAniList([{ anilistId: 999, airingAt: 3_000, episode: 7 }]);
      db.update(animes).set({ anilistId: 999 }).where(eq(animes.id, animeId)).run();

      const items = await service.getUpcoming(10, 1_000, anilist);

      expect(anilist.scheduleCalls).toEqual([[999]]);
      expect(items).toHaveLength(1);
      expect(items[0]!.nextEpisodeAt).toBe(3_000);
      expect(items[0]!.episode).toBe(7);
      const stored = db.select().from(animes).where(eq(animes.id, animeId)).get();
      expect(stored!.nextEpisodeAt).toBe(3_000);
    });

    it("falls back to stored values when the refresh fails", async () => {
      const animeId = seedAnime(db, { titleRomaji: "Airing", nextEpisodeAt: 1_500 });
      const anilist = fakeAniList([], true);
      db.update(animes).set({ anilistId: 999 }).where(eq(animes.id, animeId)).run();

      const items = await service.getUpcoming(10, 1_000, anilist);

      expect(items).toHaveLength(1);
      expect(items[0]!.nextEpisodeAt).toBe(1_500);
    });

    it("caches the schedule so repeated calls do not hit AniList within the TTL", async () => {
      const animeId = seedAnime(db, { titleRomaji: "Airing", nextEpisodeAt: 500 });
      const anilist = fakeAniList([{ anilistId: 999, airingAt: 3_000, episode: 7 }]);
      db.update(animes).set({ anilistId: 999 }).where(eq(animes.id, animeId)).run();

      let fakeNow = 1_000;
      service = new DashboardService(db, { now: () => fakeNow });
      await service.getUpcoming(10, 1_000, anilist);
      fakeNow += 10_000;
      await service.getUpcoming(10, 11_000, anilist);

      expect(anilist.scheduleCalls).toHaveLength(1);
    });

    it("refreshes the schedule again after the TTL expires", async () => {
      const animeId = seedAnime(db, { titleRomaji: "Airing", nextEpisodeAt: 500 });
      const anilist = fakeAniList([{ anilistId: 999, airingAt: 3_000, episode: 7 }]);
      db.update(animes).set({ anilistId: 999 }).where(eq(animes.id, animeId)).run();

      let fakeNow = 1_000;
      service = new DashboardService(db, { now: () => fakeNow, scheduleCacheTtlMs: 5_000 });
      await service.getUpcoming(10, 1_000, anilist);
      fakeNow += 6_000;
      await service.getUpcoming(10, 7_000, anilist);

      expect(anilist.scheduleCalls).toHaveLength(2);
    });
  });
});



