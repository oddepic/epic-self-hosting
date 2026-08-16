import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { AddToLibraryService, SonarrAddFailedError } from "./add-to-library-service";
import type { MonitorOption, SonarrClient, SonarrCandidate } from "../integrations/types";
import type { AppConfig } from "../config";
import type { SearchItem } from "./search-service";

function testConfig(): AppConfig {
  return {
    serverName: "Test Server",
    userName: "admin",
    authPassword: "x",
    databaseUrl: ":memory:",
    jellyfinUrl: "http://localhost:8096",
    jellyfinApiKey: "jf-key",
    jellyfinUserId: "jf-user",
    jellyfinWebhookSecret: "secret",
    jellyfinRefreshSecret: "",
    jellyfinServiceUsername: "epic",
    jellyfinServicePassword: "secret",
    sonarrUrl: "http://localhost:8989",
    sonarrApiKey: "sonarr-key",
    sonarrRootFolder: "D:\\Downloads\\Anime",
    sonarrQualityProfileId: 4,
    malClientId: "",
    malClientSecret: "",
  };
}

function makeSearchItem(overrides: Partial<SearchItem> = {}): SearchItem {
  return {
    anilistId: 5114,
    malId: 9756,
    title: "Fullmetal Alchemist: Brotherhood",
    romajiTitle: "Hagane no Renkinjutsushi: Fullmetal Alchemist",
    englishTitle: "Fullmetal Alchemist: Brotherhood",
    nativeTitle: "鋼の錬金術師 FULLMETAL ALCHEMIST",
    synonyms: ["FMA Brotherhood"],
    synopsis: "Two brothers search for the Philosopher's Stone.",
    coverImageUrl: "https://example.com/cover.jpg",
    bannerImageUrl: "https://example.com/banner.jpg",
    genres: ["Action", "Drama"],
    format: "TV",
    seasonYear: 2009,
    episodeCount: 64,
    nextEpisodeAt: null,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<SonarrCandidate> = {}): SonarrCandidate {
  return {
    tvdbId: 78670,
    title: "Fullmetal Alchemist: Brotherhood",
    year: 2009,
    status: "ended",
    seriesType: "standard",
    seasons: [{ seasonNumber: 1 }],
    ...overrides,
  };
}

function fakeSonarr(
  behavior: {
    candidates?: SonarrCandidate[];
    onLookup?: (term: string) => SonarrCandidate[];
    failLookup?: boolean;
    failAdd?: boolean;
  } = {},
): SonarrClient & { lookups: string[]; adds: { candidate: SonarrCandidate; root: string; profile: number; monitor?: MonitorOption }[] } {
  const lookups: string[] = [];
  const adds: { candidate: SonarrCandidate; root: string; profile: number; monitor?: MonitorOption }[] = [];
  return {
    lookups,
    adds,
    async lookup(term: string) {
      lookups.push(term);
      if (behavior.failLookup) throw new Error("lookup failed");
      return behavior.onLookup?.(term) ?? behavior.candidates ?? [];
    },
    async addSeries(candidate: SonarrCandidate, rootFolderPath: string, qualityProfileId: number, monitor?: MonitorOption) {
      adds.push({ candidate, root: rootFolderPath, profile: qualityProfileId, monitor });
      if (behavior.failAdd) throw new Error("add failed");
      return { id: 42, seasons: [{ seasonNumber: 1 }] };
    },
    async getEpisodes() {
      return [
        { id: 101, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1, title: null },
        { id: 102, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: 2, title: null },
        { id: 201, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 26, title: null },
      ];
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
      return [];
    },
    async getDiskSpace() {
      return [];
    },
    async deleteSeries() {},
  };
}

describe("AddToLibraryService.resolveCandidates", () => {
  let db: Db;
  let config: AppConfig;

  beforeEach(() => {
    db = createDb(":memory:");
    config = testConfig();
  });

  it("looks up titles in priority order, deduplicating identical titles", async () => {
    const sonarr = fakeSonarr({ candidates: [] });
    const service = new AddToLibraryService(db, config, sonarr);
    await service.resolveCandidates(makeSearchItem());
    // principal title equals the English title here, so only one lookup for both
    expect(sonarr.lookups).toEqual([
      "Fullmetal Alchemist: Brotherhood",
      "Hagane no Renkinjutsushi: Fullmetal Alchemist",
      "FMA Brotherhood",
    ]);
  });

  it("deduplicates candidates by tvdbId", async () => {
    const sonarr = fakeSonarr({
      candidates: [makeCandidate(), makeCandidate(), makeCandidate({ tvdbId: 999 })],
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const candidates = await service.resolveCandidates(makeSearchItem());
    expect(candidates.map((c) => c.tvdbId)).toEqual([78670, 999]);
  });

  it("surfaces a readable error when Sonarr is unreachable", async () => {
    const sonarr = fakeSonarr({ candidates: [], failLookup: true });
    const service = new AddToLibraryService(db, config, sonarr);
    await expect(service.resolveCandidates(makeSearchItem())).rejects.toThrow(
      "Sonarr lookup failed",
    );
  });

  it("ranks candidates by title relevance, exact match first", async () => {
    const sonarr = fakeSonarr({
      candidates: [
        makeCandidate({ tvdbId: 100, title: "Seraph of the End", year: 2015 }),
        makeCandidate({ tvdbId: 101, title: "Fullmetal Alchemist: Brotherhood", year: 2009 }),
        makeCandidate({ tvdbId: 102, title: "Fullmetal Alchemist: Brotherhood (2009) OVA", year: 2009 }),
        makeCandidate({ tvdbId: 103, title: "Brotherhood", year: 2008 }),
      ],
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const candidates = await service.resolveCandidates(makeSearchItem());
    expect(candidates.map((c) => c.tvdbId)).toEqual([101, 102, 103, 100]);
  });

  it("ranks a fuzzy match above unrelated results when no exact title exists", async () => {
    const sonarr = fakeSonarr({
      candidates: [
        makeCandidate({ tvdbId: 200, title: "Sousou no Frieren", year: 2023 }),
        makeCandidate({ tvdbId: 201, title: "The End of an Era", year: 2025 }),
      ],
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const candidates = await service.resolveCandidates(
      makeSearchItem({ title: "Frieren", englishTitle: "Frieren", romajiTitle: "Sousou no Frieren" }),
    );
    expect(candidates.map((c) => c.tvdbId)).toEqual([200, 201]);
  });
});

describe("AddToLibraryService.resolveBestMatch", () => {
  let db: Db;
  let config: AppConfig;

  beforeEach(() => {
    db = createDb(":memory:");
    config = testConfig();
  });

  it("auto-matches via the MAL id prefix when Sonarr returns exactly one candidate", async () => {
    const sonarr = fakeSonarr({
      onLookup: (term) => (term === "mal:9756" ? [makeCandidate()] : []),
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const result = await service.resolveBestMatch(makeSearchItem());
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.candidate.tvdbId).toBe(78670);
    expect(sonarr.lookups).toEqual(["mal:9756"]);
  });

  it("falls back to the AniList id prefix when the MAL id is missing", async () => {
    const sonarr = fakeSonarr({
      onLookup: (term) => (term === "anilist:5114" ? [makeCandidate()] : []),
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const result = await service.resolveBestMatch(makeSearchItem({ malId: null }));
    expect(result.matched).toBe(true);
    expect(sonarr.lookups).toEqual(["anilist:5114"]);
  });

  it("falls back to title search when both prefixes return nothing", async () => {
    const sonarr = fakeSonarr({
      onLookup: (term) => {
        if (term.startsWith("mal:") || term.startsWith("anilist:")) return [];
        return [makeCandidate()];
      },
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const result = await service.resolveBestMatch(makeSearchItem());
    expect(sonarr.lookups[0]).toBe("mal:9756");
    expect(sonarr.lookups[1]).toBe("anilist:5114");
    expect(sonarr.lookups.slice(2)).toContain("Fullmetal Alchemist: Brotherhood");
    expect(result.matched).toBe(true);
  });

  it("does not auto-match an ambiguous prefix result", async () => {
    const sonarr = fakeSonarr({
      onLookup: (term) => {
        if (term === "mal:9756") return [makeCandidate(), makeCandidate({ tvdbId: 999 })];
        if (term === "anilist:5114") return [];
        return [
          makeCandidate({ tvdbId: 999, title: "Fullmetal Alchemist: Brotherhood (2009) OVA" }),
          makeCandidate({ tvdbId: 101, title: "The Funeral" }),
        ];
      },
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const result = await service.resolveBestMatch(makeSearchItem());
    expect(result.matched).toBe(false);
  });

  it("auto-matches a unique exact title when prefixes are empty and titles are fuzzy", async () => {
    const exact = makeCandidate({ tvdbId: 100, title: "Frieren", year: 2023 });
    const sonarr = fakeSonarr({
      onLookup: (term) => {
        if (term.startsWith("mal:") || term.startsWith("anilist:")) return [];
        return term === "Frieren" ? [exact, makeCandidate({ tvdbId: 101, title: "The Funeral", year: 2022 })] : [];
      },
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const result = await service.resolveBestMatch(
      makeSearchItem({
        title: "Frieren",
        englishTitle: "Frieren",
        romajiTitle: "Frieren",
        synonyms: [],
        malId: null,
        anilistId: 154587,
      }),
    );
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.candidate.tvdbId).toBe(100);
  });

  it("does not auto-match when only fuzzy candidates exist", async () => {
    const sonarr = fakeSonarr({
      onLookup: (term) => {
        if (term.startsWith("mal:") || term.startsWith("anilist:")) return [];
        return [makeCandidate({ tvdbId: 101, title: "The Funeral", year: 2022 })];
      },
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const result = await service.resolveBestMatch(makeSearchItem());
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.candidates.length).toBeGreaterThan(0);
  });
});

describe("AddToLibraryService.addToLibrary", () => {
  let db: Db;
  let config: AppConfig;

  beforeEach(() => {
    db = createDb(":memory:");
    config = testConfig();
  });

  it("adds the confirmed candidate to Sonarr with root folder and quality profile", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(makeSearchItem(), makeCandidate());
    expect(sonarr.adds).toHaveLength(1);
    expect(sonarr.adds[0]).toMatchObject({
      candidate: makeCandidate(),
      root: "D:\\Downloads\\Anime",
      profile: 4,
    });
  });

  it("creates the anime, season and episode rows from Sonarr's episode data", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(makeSearchItem(), makeCandidate());
    const anime = db.select().from(animes).all();
    const season = db.select().from(seasons).all();
    const episode = db.select().from(episodes).all();
    expect(anime).toHaveLength(1);
    expect(anime[0]).toMatchObject({
      anilistId: 5114,
      malId: 9756,
      tvdbId: 78670,
      sonarrId: 42,
      titleRomaji: "Hagane no Renkinjutsushi: Fullmetal Alchemist",
    });
    expect(season.map((s) => s.number)).toEqual([1, 2]);
    expect(episode).toHaveLength(3);
    expect(episode.map((e) => ({ season: e.seasonId, ep: e.episodeNumber, abs: e.absoluteNumber, sonarr: e.sonarrEpisodeId }))).toEqual([
      { season: season[0]!.id, ep: 1, abs: 1, sonarr: 101 },
      { season: season[0]!.id, ep: 2, abs: 2, sonarr: 102 },
      { season: season[1]!.id, ep: 1, abs: 26, sonarr: 201 },
    ]);
  });

  it("fails cleanly when Sonarr rejects the add", async () => {
    const sonarr = fakeSonarr({ candidates: [makeCandidate()], failAdd: true });
    const service = new AddToLibraryService(db, config, sonarr);
    await expect(service.addToLibrary(makeSearchItem(), makeCandidate())).rejects.toThrow(
      SonarrAddFailedError,
    );
    expect(db.select().from(animes).all()).toHaveLength(0);
  });

  it("re-links an existing anime instead of duplicating it", async () => {
    db.insert(animes).values({
      anilistId: 5114,
      malId: 9756,
      titleRomaji: "Fullmetal Alchemist: Brotherhood",
      status: "watching",
      createdAt: 1,
      updatedAt: 1,
    }).run();

    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(makeSearchItem(), makeCandidate());

    const rows = db.select().from(animes).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sonarrId).toBe(42);
    expect(rows[0]!.tvdbId).toBe(78670);
    expect(rows[0]!.status).toBe("watching");
    expect(db.select().from(seasons).all()).toHaveLength(2);
    expect(db.select().from(episodes).all()).toHaveLength(3);
  });

  it("monitors all seasons for an anime not in the season map", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(makeSearchItem(), makeCandidate());
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "all" });
  });

  it("falls back to the title's season marker when the anime is not in the map", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(
      makeSearchItem({ title: "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season" }),
      makeCandidate({ seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }, { seasonNumber: 4 }] }),
    );
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "specificSeason", season: 4 });
  });

  it("falls back to a Part N marker folded through the franchise table", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(
      makeSearchItem({
        title: "JoJo no Kimyou na Bouken: Steel Ball Run - 1st STAGE",
        synonyms: ["JoJo's Bizarre Adventure: Part 7–Steel Ball Run"],
        format: "ONA",
        episodeCount: 1,
      }),
      makeCandidate({
        tvdbId: 262954,
        seasons: [
          { seasonNumber: 1 },
          { seasonNumber: 2 },
          { seasonNumber: 3 },
          { seasonNumber: 4 },
          { seasonNumber: 5 },
          { seasonNumber: 6 },
        ],
      }),
    );
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "specificSeason", season: 6 });
  });

  it("falls back to the last season for an unlisted franchise sub-entry", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(
      makeSearchItem({ title: "Mystery Movie", format: "MOVIE", episodeCount: 1 }),
      makeCandidate({ seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }] }),
    );
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "specificSeason", season: 2 });
  });

  it("resolves the season from the bundled anime-lists map (SBR -> season 6)", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(
      makeSearchItem({
        anilistId: 190327,
        malId: 61469,
        title: "Some Arbitrary Label With No Season Hints",
        romajiTitle: null,
        englishTitle: null,
        synonyms: [],
        format: "ONA",
        episodeCount: 1,
      }),
      makeCandidate({
        tvdbId: 262954,
        seasons: [
          { seasonNumber: 1 },
          { seasonNumber: 2 },
          { seasonNumber: 3 },
          { seasonNumber: 4 },
          { seasonNumber: 5 },
          { seasonNumber: 6 },
        ],
      }),
    );
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "specificSeason", season: 6 });
  });

  it("resolves a folded franchise arc from the map (Swordsmith Village -> season 4)", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(
      makeSearchItem({
        anilistId: 145139,
        malId: 51019,
        title: "Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc",
        romajiTitle: null,
        englishTitle: null,
        synonyms: [],
        format: "TV",
        episodeCount: 11,
      }),
      makeCandidate({
        tvdbId: 348545,
        seasons: [
          { seasonNumber: 1 },
          { seasonNumber: 2 },
          { seasonNumber: 3 },
          { seasonNumber: 4 },
          { seasonNumber: 5 },
        ],
      }),
    );
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "specificSeason", season: 4 });
  });

  it("falls back to all seasons when the map points to a different tvdb series", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(
      makeSearchItem({ anilistId: 190327, malId: 61469 }),
      makeCandidate({
        tvdbId: 999_999,
        seasons: [{ seasonNumber: 1 }],
      }),
    );
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "all" });
  });

  it("falls back to all seasons when the mapped season is not in the candidate", async () => {
    const sonarr = fakeSonarr();
    const service = new AddToLibraryService(db, config, sonarr);
    await service.addToLibrary(
      makeSearchItem({ anilistId: 190327, malId: 61469 }),
      makeCandidate({
        tvdbId: 262954,
        seasons: [{ seasonNumber: 1 }],
      }),
    );
    expect(sonarr.adds[0]!.monitor).toEqual({ type: "all" });
  });

  it("suggests the mapped season from a matched prefix lookup", async () => {
    const sonarr = fakeSonarr({
      onLookup: () => [
        { tvdbId: 262954, title: "JoJo's Bizarre Adventure (2012)", year: 2012, status: "continuing", seriesType: "standard", seasons: [{ seasonNumber: 1 }, { seasonNumber: 2 }, { seasonNumber: 3 }, { seasonNumber: 4 }, { seasonNumber: 5 }, { seasonNumber: 6 }] },
      ],
    });
    const service = new AddToLibraryService(db, config, sonarr);
    const result = await service.resolveBestMatch(
      makeSearchItem({
        anilistId: 190327,
        malId: 61469,
        title: "JoJo no Kimyou na Bouken: Steel Ball Run - 1st STAGE",
        synonyms: ["JoJo's Bizarre Adventure: Part 7–Steel Ball Run"],
        format: "ONA",
        episodeCount: 1,
      }),
    );
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.monitor).toEqual({ type: "specificSeason", season: 6 });
    }
  });
});








