import { describe, it, expect } from "vitest";
import { buildAddSeriesBody, buildEpisodeSearchCommand, countRealEpisodes } from "./sonarr-client";
import type { SonarrCandidate } from "./types";

function makeCandidate(overrides: Partial<SonarrCandidate> = {}): SonarrCandidate {
  return {
    tvdbId: 305089,
    title: "Any Anime",
    year: 2025,
    status: "continuing",
    seriesType: "anime",
    seasons: [
      { seasonNumber: 0 },
      { seasonNumber: 1 },
      { seasonNumber: 2 },
      { seasonNumber: 3 },
      { seasonNumber: 4 },
    ],
    ...overrides,
  };
}

describe("buildAddSeriesBody", () => {
  it("monitors all seasons by default", () => {
    const body = buildAddSeriesBody(makeCandidate(), "/root", 8);
    expect(body["monitored"]).toBe(true);
    expect(body["monitor"]).toBe("all");
    expect(body["seasons"]).toBeUndefined();
    expect(body["addOptions"]).toMatchObject({
      searchForMissingEpisodes: true,
    });
  });

  it("maps first/last/future/missing/recent monitor types", () => {
    for (const type of ["firstSeason", "lastSeason", "future", "missing", "recent"] as const) {
      const body = buildAddSeriesBody(makeCandidate(), "/root", 8, { type });
      expect(body["monitor"]).toBe(type);
      expect(body["seasons"]).toBeUndefined();
    }
  });

  it("monitors only the specific season", () => {
    const body = buildAddSeriesBody(makeCandidate(), "/root", 8, { type: "specificSeason", season: 4 });
    expect(body["monitor"]).toBe("specificSeason");
    const seasons = body["seasons"] as { seasonNumber: number; monitored: boolean }[];
    expect(seasons).toEqual([
      { seasonNumber: 0, monitored: false },
      { seasonNumber: 1, monitored: false },
      { seasonNumber: 2, monitored: false },
      { seasonNumber: 3, monitored: false },
      { seasonNumber: 4, monitored: true },
    ]);
    expect(body["addOptions"]).toMatchObject({
      searchForMissingEpisodes: true,
      monitorNewItems: false,
    });
  });
});

describe("countRealEpisodes", () => {
  it("excludes specials (season 0) from the episode total", () => {
    const seasons = [
      { seasonNumber: 0, statistics: { totalEpisodeCount: 70 } },
      { seasonNumber: 1, statistics: { totalEpisodeCount: 25 } },
      { seasonNumber: 2, statistics: { totalEpisodeCount: 25 } },
      { seasonNumber: 3, statistics: { totalEpisodeCount: 16 } },
      { seasonNumber: 4, statistics: { totalEpisodeCount: 19 } },
    ];

    expect(countRealEpisodes(seasons)).toBe(85);
  });

  it("tolerates seasons without statistics", () => {
    expect(countRealEpisodes([{ seasonNumber: 0 }, { seasonNumber: 1 }])).toBe(0);
  });
});

describe("buildEpisodeSearchCommand", () => {
  it("targets only the explicit missing episode ids", () => {
    expect(buildEpisodeSearchCommand([5203, 5199, 5203])).toEqual({
      name: "EpisodeSearch",
      episodeIds: [5203, 5199],
    });
  });
});
