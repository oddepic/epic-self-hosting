import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { SonarrDashboardService } from "./sonarr-dashboard-service";
import type { SonarrClient, SonarrSeries } from "../integrations/types";

function fakeSonarr(series: SonarrSeries[], disks: { path: string; freeSpace: number; totalSpace: number }[] = []): SonarrClient & { seriesCalls: number; diskCalls: number } {
  const state = { seriesCalls: 0, diskCalls: 0 };
  return {
    get seriesCalls() {
      return state.seriesCalls;
    },
    get diskCalls() {
      return state.diskCalls;
    },
    async lookup() {
      return [];
    },
    async addSeries() {
      return { id: 1 };
    },
    async getEpisodes() {
      return [];
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
      return { id: 1 };
    },
    async updateQualityProfile() {
      return {};
    },
    async getCustomFormats() {
      return [];
    },
    async createCustomFormat() {
      return { id: 1 };
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
    async getMissingMonitoredBySeries() {
      return [];
    },
    async searchEpisodes() {
      return { id: 1 };
    },
    async getSeries() {
      state.seriesCalls++;
      return series;
    },
    async getDiskSpace() {
      state.diskCalls++;
      return disks;
    },
    async deleteSeries() {},
  };
}

function makeSeries(overrides: Partial<SonarrSeries> = {}): SonarrSeries {
  return {
    id: 1,
    tvdbId: 424536,
    title: "Any Anime",
    year: 2026,
    status: "continuing",
    monitored: true,
    episodeFileCount: 10,
    totalEpisodeCount: 12,
    monitoredEpisodesTotal: 12,
    sizeOnDisk: 100,
    addedAt: null,
    ...overrides,
  };
}

describe("SonarrDashboardService", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  describe("getOverview", () => {
    it("sums library size and series count, and reports free space for the root folder", async () => {
      const sonarr = fakeSonarr(
        [makeSeries({ sizeOnDisk: 100 }), makeSeries({ id: 2, sizeOnDisk: 200 })],
        [{ path: "/data/anime", freeSpace: 1_000, totalSpace: 5_000 }],
      );
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const overview = await service.getOverview();

      expect(overview).toEqual({ librarySizeBytes: 300, seriesCount: 2, freeBytes: 1_000 });
    });

    it("reports zero free space when the root folder is not in the disk list", async () => {
      const sonarr = fakeSonarr([makeSeries()], [{ path: "/other", freeSpace: 9_999, totalSpace: 10_000 }]);
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const overview = await service.getOverview();

      expect(overview.freeBytes).toBe(0);
    });

    it("returns zeroes when there are no series", async () => {
      const service = new SonarrDashboardService(db, fakeSonarr([]), { rootFolder: "/data/anime" });

      const overview = await service.getOverview();

      expect(overview).toEqual({ librarySizeBytes: 0, seriesCount: 0, freeBytes: 0 });
    });
  });

  describe("getLibrary", () => {
    it("returns rows sorted by title with a size ratio against the largest series", async () => {
      const sonarr = fakeSonarr([
        makeSeries({ id: 2, title: "Zeta", sizeOnDisk: 50 }),
        makeSeries({ id: 1, title: "Alpha", sizeOnDisk: 200 }),
      ]);
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const rows = await service.getLibrary();

      expect(rows.map((r) => r.title)).toEqual(["Alpha", "Zeta"]);
      expect(rows[0]).toMatchObject({ year: 2026, status: "continuing", monitored: true });
      expect(rows[0]!.sizeRatio).toBe(1);
      expect(rows[1]!.sizeRatio).toBe(0.25);
    });

    it("guards against zero total episodes for the episodes label", async () => {
      const sonarr = fakeSonarr([makeSeries({ episodeFileCount: 0, totalEpisodeCount: 0, monitoredEpisodesTotal: 0 })]);
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const rows = await service.getLibrary();

      expect(rows[0]!.episodesLabel).toBe("0/0");
    });

    it("uses the monitored episode scope like the Downloads view", async () => {
      const sonarr = fakeSonarr([
        makeSeries({ episodeFileCount: 5, totalEpisodeCount: 35, monitoredEpisodesTotal: 13 }),
      ]);
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const rows = await service.getLibrary();

      expect(rows[0]!.episodesLabel).toBe("5/13");
    });

    it("reports download status per series", async () => {
      const sonarr = fakeSonarr([
        makeSeries({ id: 1, episodeFileCount: 25, totalEpisodeCount: 25 }),
        makeSeries({ id: 2, episodeFileCount: 4, totalEpisodeCount: 85 }),
        makeSeries({ id: 3, episodeFileCount: 0, totalEpisodeCount: 13 }),
      ]);
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const rows = await service.getLibrary();

      expect(rows.find((r) => r.id === 1)!.downloadStatus).toBe("finished");
      expect(rows.find((r) => r.id === 2)!.downloadStatus).toBe("downloading");
      expect(rows.find((r) => r.id === 3)!.downloadStatus).toBe("downloading");
    });

    it("marks a series missing and sets its missing count from Sonarr", async () => {
      const sonarr = fakeSonarr([makeSeries({ episodeFileCount: 5, monitoredEpisodesTotal: 13 })]);
      sonarr.getMissingMonitoredBySeries = async () => [
        { seriesId: 1, episodeIds: [5203, 5199, 5198] },
      ];
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const rows = await service.getLibrary();

      expect(rows[0]).toMatchObject({ missingCount: 3, downloadStatus: "missing" });
    });

    it("labels when the series was downloaded relative to now", async () => {
      const now = 1_000_000_000_000;
      const day = 24 * 60 * 60 * 1000;
      const sonarr = fakeSonarr([
        makeSeries({ id: 1, addedAt: now }),
        makeSeries({ id: 2, addedAt: now - day }),
        makeSeries({ id: 3, addedAt: now - 5 * day }),
        makeSeries({ id: 4, addedAt: null }),
      ]);
      const service = new SonarrDashboardService(db, sonarr, { rootFolder: "/data/anime" });

      const rows = await service.getLibrary(now);

      expect(rows.find((r) => r.id === 1)!.addedLabel).toBe("Today");
      expect(rows.find((r) => r.id === 2)!.addedLabel).toBe("Yesterday");
      expect(rows.find((r) => r.id === 3)!.addedLabel).toBe("5 Days Ago");
      expect(rows.find((r) => r.id === 4)!.addedLabel).toBe("—");
    });
  });
});



