import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { AvailabilityService, sanitizeEpisodeTitle } from "./availability-service";
import type { JellyfinEpisodeItem, JellyfinSeriesItem, SonarrClient, SonarrSeries } from "../integrations/types";

function fakeSonarr(behavior: {
  episodes?: { seasonNumber: number; episodeNumber: number; absoluteEpisodeNumber: number | null; id: number }[];
  series?: SonarrSeries[];
} = {}) {
  return {
    async lookup() {
      return [];
    },
    async addSeries() {
      return { id: 1 };
    },
    async getEpisodes() {
      return behavior.episodes ?? [];
    },
    async getQueue() {
      return [];
    },
    async getEpisodeFiles() {
      return [];
    },
    async getQualityProfiles() {
      return [];
    },
    async getQualityDefinitions() {
      return [];
    },
    async createQualityProfile() {
      return { id: 99 };
    },
    async updateQualityProfile() {
      return {};
    },
    async getCustomFormats() {
      return [];
    },
    async createCustomFormat() {
      return { id: 99 };
    },
    async updateCustomFormat() {
      return {};
    },
    async getManualImport() {
      return [];
    },
    async triggerImport() {
      return { id: 1 };
    },
    async getSeries() {
      return behavior.series ?? [];
    },
    async getDiskSpace() {
      return [];
    },
    async deleteSeries() {},
  } as unknown as SonarrClient;
}

function seedAnimeOnly(db: Db, overrides: Partial<typeof animes.$inferInsert> = {}): number {
  return db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      tvdbId: 424536,
      titleRomaji: "Sousou no Frieren",
      titleEnglish: "Frieren: Beyond Journey's End",
      status: "watching",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .returning()
    .get().id;
}

function seedAnime(
  db: Db,
  overrides: Partial<typeof animes.$inferInsert> = {},
): { animeId: number; seasonId: number; episodeId: number } {
  const anime = db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      tvdbId: 424536,
      titleRomaji: "Sousou no Frieren",
      titleEnglish: "Frieren: Beyond Journey's End",
      status: "watching",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .returning()
    .get();
  const season = db
    .insert(seasons)
    .values({ animeId: anime.id, number: 1 })
    .returning()
    .get();
  const episode = db
    .insert(episodes)
    .values({ seasonId: season.id, episodeNumber: 1, progressSeconds: 0 })
    .returning()
    .get();
  return { animeId: anime.id, seasonId: season.id, episodeId: episode.id };
}

function makeSeries(overrides: Partial<JellyfinSeriesItem> = {}): JellyfinSeriesItem {
  return { id: "jf-series-1", tvdbId: 424536, title: "Frieren: Beyond Journey's End", ...overrides };
}

function makeEpisodeItem(overrides: Partial<JellyfinEpisodeItem> = {}): JellyfinEpisodeItem {
  return { id: "jf-ep-1", seasonNumber: 1, episodeNumber: 1, name: null, thumbnailUrl: null, userData: null, ...overrides };
}

function fakeJellyfin(behavior: {
  series?: JellyfinSeriesItem[];
  episodes?: JellyfinEpisodeItem[];
  seriesAfterRefresh?: JellyfinSeriesItem[];
} = {}) {
  return {
    series: behavior.series ?? [],
    seriesAfterRefresh: behavior.seriesAfterRefresh,
    episodesBySeries: behavior.episodes ?? [],
    rebuildCalls: [] as number[],
    async getSeries() {
      if (this.seriesAfterRefresh !== undefined && this.rebuildCalls.length > 0) {
        return this.seriesAfterRefresh;
      }
      return this.series;
    },
    async getEpisodes(seriesId: string) {
      if (seriesId === "jf-series-1") return this.episodesBySeries;
      return [];
    },
    async getSessions() {
      return [];
    },
    async authenticateUserByName() {
      return { accessToken: "t", userId: "u" };
    },
    async getMediaStreams() {
      return [];
    },
    async getMediaSource() {
      return { mediaSourceId: "ms-1", streams: [], attachments: [] };
    },
    async getPlaybackInfo() {
      return { url: "http://x", playMethod: "DirectStream" as const, mediaSourceId: null, playSessionId: null };
    },
    async getIntroSkipperSegments() {
      return { intro: null, credits: null };
    },
    async requestPlayback() {},
    async listAllItemIds() {
      return [];
    },
    async deleteItem() {},
    async refreshLibrary() {
      this.rebuildCalls.push(Date.now());
    },

  };
}

describe("AvailabilityService.sync", () => {
  let db: Db;
  let service: AvailabilityService;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("materializes episode rows from Sonarr for anime with a sonarr id but no seasons", async () => {
    db.insert(animes).values({
      anilistId: 999_001,
      sonarrId: 42,
      tvdbId: null,
      titleRomaji: "Bare Series",
      status: "watching",
      createdAt: 1,
      updatedAt: 1,
    }).run();
    service = new AvailabilityService(
      db,
      fakeJellyfin(),
      fakeSonarr({
        episodes: [
          { id: 101, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1 },
          { id: 102, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: 2 },
          { id: 201, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 25 },
        ],
      }),
      { rebuildDelayMs: 0 },
    );
    await service.sync();

    const seasonRows = db.select().from(seasons).all();
    const episodeRows = db.select().from(episodes).all();
    expect(seasonRows.map((s) => s.number)).toEqual([1, 2]);
    expect(episodeRows).toHaveLength(3);
    expect(episodeRows[0]).toMatchObject({ sonarrEpisodeId: 101, episodeNumber: 1, absoluteNumber: 1 });
    expect(episodeRows[2]).toMatchObject({ sonarrEpisodeId: 201, absoluteNumber: 25 });
  });

  it("matches anime to Jellyfin series by TVDB id and records the jellyfin id", async () => {
    const { animeId } = seedAnime(db);
    service = new AvailabilityService(db, fakeJellyfin({ series: [makeSeries()] }));
    const result = await service.sync();

    expect(result.seriesMatched).toBe(1);
    const row = db.select().from(animes).where(eq(animes.id, animeId)).get();
    expect(row!.jellyfinId).toBe("jf-series-1");
  });

  it("matches by normalized title when the TVDB id is unknown on either side", async () => {
    const { animeId } = seedAnime(db, { tvdbId: null });
    service = new AvailabilityService(
      db,
      fakeJellyfin({ series: [makeSeries({ tvdbId: null, title: "Sousou no Frieren" })] }),
    );
    const result = await service.sync();

    expect(result.seriesMatched).toBe(1);
    const row = db.select().from(animes).where(eq(animes.id, animeId)).get();
    expect(row!.jellyfinId).toBe("jf-series-1");
  });

  it("marks episodes available and stores the jellyfin item id", async () => {
    const { episodeId } = seedAnime(db);
    service = new AvailabilityService(
      db,
      fakeJellyfin({ series: [makeSeries()], episodes: [makeEpisodeItem()] }),
    );
    const result = await service.sync();

    expect(result.episodesAvailable).toBe(1);
    const row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(row!.available).toBe(true);
    expect(row!.jellyfinItemId).toBe("jf-ep-1");
  });

  it("heals completion from UserData played flag", async () => {
    const { episodeId } = seedAnime(db);
    service = new AvailabilityService(
      db,
      fakeJellyfin({
        series: [makeSeries()],
        episodes: [makeEpisodeItem({ userData: { played: true, positionTicks: 0 } })],
      }),
    );
    await service.sync();

    const row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(row!.watched).toBe(true);
    expect(row!.progressSeconds).toBe(0);
  });

  it("heals a resume position from UserData position ticks", async () => {
    const { episodeId } = seedAnime(db);
    service = new AvailabilityService(
      db,
      fakeJellyfin({
        series: [makeSeries()],
        episodes: [makeEpisodeItem({ userData: { played: false, positionTicks: 1_250_000_000 } })],
      }),
    );
    await service.sync();

    const row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(row!.progressSeconds).toBe(125);
    expect(row!.watched).toBe(false);
  });

  it("does not touch progress when there is no user data", async () => {
    const { episodeId } = seedAnime(db);
    service = new AvailabilityService(db, fakeJellyfin({ series: [makeSeries()], episodes: [makeEpisodeItem()] }));
    await service.sync();

    const row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(row!.progressSeconds).toBe(0);
    expect(row!.watched).toBe(false);
  });

  it("is idempotent — a second sync changes nothing", async () => {
    const { episodeId } = seedAnime(db);
    service = new AvailabilityService(
      db,
      fakeJellyfin({
        series: [makeSeries()],
        episodes: [makeEpisodeItem({ userData: { played: true, positionTicks: 0 } })],
      }),
    );
    const first = await service.sync();
    const second = await service.sync();

    expect(second).toEqual(first);
    const row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(row!.watched).toBe(true);
  });

  it("survives a Jellyfin series that cannot serve episodes", async () => {
    const { animeId, episodeId } = seedAnime(db);
    const jellyfin = fakeJellyfin({
      series: [makeSeries()],
      episodes: [makeEpisodeItem()],
    });
    jellyfin.getEpisodes = async () => {
      throw new Error("Series not found");
    };
    service = new AvailabilityService(db, jellyfin);

    const result = await service.sync();

    expect(result.seriesMatched).toBe(1);
    expect(result.episodesAvailable).toBe(0);
    const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(episode!.available).toBe(false);
    const anime = db.select().from(animes).where(eq(animes.id, animeId)).get();
    expect(anime!.jellyfinId).toBe("jf-series-1");
  });

  it("reports zeroes when nothing matches", async () => {
    seedAnime(db, { tvdbId: 999_999 });
    service = new AvailabilityService(db, fakeJellyfin());
    const result = await service.sync();
    expect(result).toEqual({ seriesMatched: 0, seriesLinked: 0, episodesAvailable: 0, progressUpdated: 0 });
  });

  it("links an orphaned anime to its Sonarr series by tvdb id", async () => {
    const { animeId } = seedAnime(db, { sonarrId: null, tvdbId: 424536 });
    service = new AvailabilityService(
      db,
      fakeJellyfin(),
      fakeSonarr({ series: [{ id: 20, tvdbId: 424536, title: "Any Anime", year: 2026, status: "continuing", monitored: true, episodeFileCount: 8, totalEpisodeCount: 13, monitoredEpisodesTotal: 13, sizeOnDisk: 100, addedAt: null }] }),
    );
    const result = await service.sync();

    const row = db.select().from(animes).where(eq(animes.id, animeId)).get();
    expect(row!.sonarrId).toBe(20);
    expect(result.seriesLinked).toBe(1);
  });

  it("links an orphaned anime by normalized title when there is no tvdb id", async () => {
    const { animeId } = seedAnime(db, { sonarrId: null, tvdbId: null, titleRomaji: "Sentenced to be a Hero" });
    service = new AvailabilityService(
      db,
      fakeJellyfin(),
      fakeSonarr({ series: [{ id: 33, tvdbId: 555, title: "Sentenced to Be a Hero", year: 2026, status: "continuing", monitored: true, episodeFileCount: 8, totalEpisodeCount: 13, monitoredEpisodesTotal: 13, sizeOnDisk: 100, addedAt: null }] }),
    );
    const result = await service.sync();

    const row = db.select().from(animes).where(eq(animes.id, animeId)).get();
    expect(row!.sonarrId).toBe(33);
    expect(row!.tvdbId).toBe(555);
    expect(result.seriesLinked).toBe(1);
  });

  it("materializes episodes and marks them available in the same sync after linking", async () => {
    seedAnimeOnly(db, { sonarrId: null });
    service = new AvailabilityService(
      db,
      fakeJellyfin({
        series: [makeSeries()],
        episodes: [makeEpisodeItem()],
      }),
      fakeSonarr({
        series: [{ id: 20, tvdbId: 424536, title: "Any Anime", year: 2026, status: "continuing", monitored: true, episodeFileCount: 8, totalEpisodeCount: 13, monitoredEpisodesTotal: 13, sizeOnDisk: 100, addedAt: null }],
        episodes: [{ id: 101, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1 }],
      }),
    );
    const result = await service.sync();

    const episode = db.select().from(episodes).get();
    expect(episode).toMatchObject({ episodeNumber: 1, available: true, sonarrEpisodeId: 101 });
    expect(result.episodesAvailable).toBe(1);
  });

  it("rebuilds an empty Jellyfin library when anime are linked to Sonarr", async () => {
    seedAnime(db, { sonarrId: 42, tvdbId: 424536 });
    const jellyfin = fakeJellyfin({
      seriesAfterRefresh: [makeSeries()],
      episodes: [makeEpisodeItem()],
    });
    service = new AvailabilityService(
      db,
      jellyfin,
      fakeSonarr(),
      { rebuildDelayMs: 0 },
    );

    const result = await service.sync();

    expect(jellyfin.rebuildCalls).toHaveLength(1);
    expect(result.jellyfinRebuilt).toBe(true);
    expect(result.seriesMatched).toBe(1);
  });

  it("does not rebuild when Jellyfin is empty but nothing is linked to Sonarr", async () => {
    seedAnime(db, { sonarrId: null, tvdbId: 424536 });
    const jellyfin = fakeJellyfin();
    service = new AvailabilityService(db, jellyfin, fakeSonarr(), { rebuildDelayMs: 0 });

    const result = await service.sync();

    expect(jellyfin.rebuildCalls).toHaveLength(0);
    expect(result.jellyfinRebuilt).toBeUndefined();
    expect(result.seriesMatched).toBe(0);
  });

  it("does not rebuild when Jellyfin already has series", async () => {
    seedAnime(db, { sonarrId: 42, tvdbId: 424536 });
    const jellyfin = fakeJellyfin({ series: [makeSeries()], episodes: [makeEpisodeItem()] });
    service = new AvailabilityService(db, jellyfin, fakeSonarr(), { rebuildDelayMs: 0 });

    const result = await service.sync();

    expect(jellyfin.rebuildCalls).toHaveLength(0);
    expect(result.jellyfinRebuilt).toBeUndefined();
    expect(result.seriesMatched).toBe(1);
  });

  it("stores real Jellyfin episode names and drops fallback junk", async () => {
    const { seasonId } = seedAnime(db);
    const ep2 = db
      .insert(episodes)
      .values({ seasonId, episodeNumber: 2, progressSeconds: 0 })
      .returning()
      .get();
    db.insert(episodes).values({ seasonId, episodeNumber: 3, progressSeconds: 0 }).run();
    // Pre-existing junk must be cleaned when Jellyfin still returns junk.
    db.update(episodes).set({ title: "Frieren: Beyond Journey's End" }).where(eq(episodes.id, ep2.id)).run();

    const jellyfin = fakeJellyfin({
      series: [makeSeries()],
      episodes: [
        makeEpisodeItem({ name: "The Journey's End" }),
        makeEpisodeItem({ id: "jf-ep-2", episodeNumber: 2, name: "Frieren: Beyond Journey's End" }),
        makeEpisodeItem({ id: "jf-ep-3", episodeNumber: 3, name: "Episode 3" }),
      ],
    });
    service = new AvailabilityService(db, jellyfin);
    await service.sync();

    const rows = db
      .select()
      .from(episodes)
      .where(eq(episodes.seasonId, seasonId))
      .orderBy(episodes.episodeNumber)
      .all();
    expect(rows[0]!.title).toBe("The Journey's End");
    expect(rows[1]!.title).toBeNull();
    expect(rows[2]!.title).toBeNull();
  });

  it("does not wipe an existing title when Jellyfin has no name", async () => {
    const { episodeId } = seedAnime(db);
    db.update(episodes).set({ title: "The Journey's End" }).where(eq(episodes.id, episodeId)).run();
    service = new AvailabilityService(
      db,
      fakeJellyfin({ series: [makeSeries()], episodes: [makeEpisodeItem({ name: null })] }),
    );
    await service.sync();

    const row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    expect(row!.title).toBe("The Journey's End");
  });
});

describe("sanitizeEpisodeTitle", () => {
  it("keeps real episode titles", () => {
    expect(sanitizeEpisodeTitle("The Journey's End", ["Foo", null])).toBe("The Journey's End");
  });

  it("drops the series name used as a fallback title", () => {
    expect(sanitizeEpisodeTitle("Foo", ["Foo"])).toBeNull();
    expect(sanitizeEpisodeTitle("  foo  ", ["Bar", "Foo"])).toBeNull();
  });

  it("drops episode-number fallbacks", () => {
    expect(sanitizeEpisodeTitle("Episode 5", ["Foo"])).toBeNull();
    expect(sanitizeEpisodeTitle("EP 5", ["Foo"])).toBeNull();
    expect(sanitizeEpisodeTitle("5", ["Foo"])).toBeNull();
    expect(sanitizeEpisodeTitle("Episode #4.8", ["Foo"])).toBeNull();
  });

  it("drops the series name even when punctuation differs", () => {
    expect(sanitizeEpisodeTitle("Re ZERO Starting Life in Another World", ["Re:ZERO -Starting Life in Another World-"])).toBeNull();
  });

  it("drops empty and missing names", () => {
    expect(sanitizeEpisodeTitle(null, ["Foo"])).toBeNull();
    expect(sanitizeEpisodeTitle("   ", ["Foo"])).toBeNull();
  });
});








