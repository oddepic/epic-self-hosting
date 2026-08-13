import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { animes } from "../db/schema";
import { DownloadStatusService } from "./download-status-service";
import type { SonarrClient, SonarrSeries } from "../integrations/types";

interface QueueRecord {
  seriesId: number;
  title: string;
  status: string;
  trackedDownloadState: string;
  errorMessage: string | null;
  downloadClient: string | null;
}

function makeSeries(overrides: Partial<SonarrSeries> = {}): SonarrSeries {
  return {
    id: 7,
    tvdbId: 424536,
    title: "Test Anime",
    year: 2026,
    status: "continuing",
    monitored: true,
    episodeFileCount: 5,
    totalEpisodeCount: 12,
    monitoredEpisodesTotal: 12,
    sizeOnDisk: 100,
    addedAt: null,
    ...overrides,
  };
}

function fakeSonarr(behavior: { queue?: QueueRecord[]; series?: SonarrSeries[] } = {}): SonarrClient {
  const queue = behavior.queue ?? [];
  const series = behavior.series ?? [];
  return {
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
      return queue;
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
    async getSeries() {
      return series;
    },
    async getDiskSpace() {
      return [];
    },
    async deleteSeries() {},
  };
}

function seedAnime(db: Db, overrides: Partial<typeof animes.$inferInsert> = {}): number {
  const row = db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      titleRomaji: "Test Anime",
      sonarrId: 7,
      status: "watching",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .returning()
    .get();
  return row.id;
}

function makeQueueRecord(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    seriesId: 7,
    title: "Test Anime",
    status: "downloading",
    trackedDownloadState: "downloading",
    errorMessage: null,
    downloadClient: "qBittorrent",
    ...overrides,
  };
}

describe("DownloadStatusService.getDownloadStatus", () => {
  let db: Db;
  let service: DownloadStatusService;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("shows episode progress from series file counts against the monitored scope", async () => {
    seedAnime(db, { titleRomaji: "Test Anime", sonarrId: 7 });
    service = new DownloadStatusService(
      db,
      fakeSonarr({ queue: [makeQueueRecord()], series: [makeSeries({ episodeFileCount: 5, monitoredEpisodesTotal: 12 })] }),
    );

    const items = await service.getDownloadStatus();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      animeTitle: "Test Anime",
      filesDownloaded: 5,
      totalEpisodes: 12,
      percent: 42,
      state: "downloading",
      downloadClient: "qBittorrent",
      error: null,
    });
  });

  it("uses the monitored season scope for the total (e.g. season 22 only)", async () => {
    seedAnime(db);
    service = new DownloadStatusService(
      db,
      fakeSonarr({
        queue: [makeQueueRecord()],
        series: [makeSeries({ episodeFileCount: 8, monitoredEpisodesTotal: 13, totalEpisodeCount: 1100 })],
      }),
    );

    const items = await service.getDownloadStatus();
    expect(items[0]!.totalEpisodes).toBe(13);
    expect(items[0]!.percent).toBe(62);
  });

  it("ignores queue records for anime not in the library", async () => {
    seedAnime(db, { sonarrId: 7 });
    service = new DownloadStatusService(
      db,
      fakeSonarr({ queue: [makeQueueRecord({ seriesId: 999 })], series: [makeSeries({ id: 999 })] }),
    );

    const items = await service.getDownloadStatus();
    expect(items).toHaveLength(0);
  });

  it("reports failed downloads with their error message", async () => {
    seedAnime(db);
    service = new DownloadStatusService(
      db,
      fakeSonarr({
        queue: [makeQueueRecord({ status: "completed", trackedDownloadState: "failed", errorMessage: "Download discarded" })],
        series: [makeSeries()],
      }),
    );

    const items = await service.getDownloadStatus();
    expect(items[0]).toMatchObject({ state: "failed", error: "Download discarded" });
  });

  it("reports 100 percent when all monitored episodes are downloaded", async () => {
    seedAnime(db);
    service = new DownloadStatusService(
      db,
      fakeSonarr({
        queue: [makeQueueRecord({ status: "completed", trackedDownloadState: "imported" })],
        series: [makeSeries({ episodeFileCount: 12, monitoredEpisodesTotal: 12 })],
      }),
    );

    const items = await service.getDownloadStatus();
    expect(items[0]!.percent).toBe(100);
    expect(items[0]!.state).toBe("imported");
  });

  it("orders downloading items first, then by anime title", async () => {
    seedAnime(db, { titleRomaji: "Zeta", sonarrId: 1 });
    seedAnime(db, { titleRomaji: "Alpha", sonarrId: 2 });
    service = new DownloadStatusService(
      db,
      fakeSonarr({
        queue: [
          makeQueueRecord({ seriesId: 1, title: "Zeta", trackedDownloadState: "imported" }),
          makeQueueRecord({ seriesId: 2, title: "Alpha", trackedDownloadState: "downloading" }),
        ],
        series: [
          makeSeries({ id: 1, title: "Zeta" }),
          makeSeries({ id: 2, title: "Alpha" }),
        ],
      }),
    );

    const items = await service.getDownloadStatus();
    expect(items.map((i) => i.animeTitle)).toEqual(["Alpha", "Zeta"]);
  });
});
