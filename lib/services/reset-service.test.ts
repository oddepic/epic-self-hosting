import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes, users, malTokens, playbackHistory, trackPreferences, sessions } from "../db/schema";
import { ResetService } from "./reset-service";
import type { JellyfinClient, SonarrClient, SonarrSeries } from "../integrations/types";

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

function fakeSonarr(): SonarrClient & { deleted: { id: number; deleteFiles: boolean }[] } {
  const deleted: { id: number; deleteFiles: boolean }[] = [];
  return {
    deleted,
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
      return [makeSeries({ id: 21 }), makeSeries({ id: 22 })];
    },
    async getDiskSpace() {
      return [];
    },
    async deleteSeries(id: number, deleteFiles: boolean) {
      deleted.push({ id, deleteFiles });
    },
  };
}

function fakeJellyfin(): JellyfinClient & { deleted: string[]; refreshed: number } {
  const state = { deleted: [] as string[], refreshed: 0 };
  return {
    get deleted() {
      return state.deleted;
    },
    get refreshed() {
      return state.refreshed;
    },
    async getSeries() {
      return [
        { id: "jf-s1", tvdbId: 1, title: "Any Anime" },
        { id: "jf-s2", tvdbId: 2, title: "Another Anime" },
      ];
    },
    async getEpisodes() {
      return [];
    },
    async getSessions() {
      return [];
    },
    async getMediaStreams() {
      return [];
    },
    async getMediaSource() {
      return { mediaSourceId: "ms-1", streams: [], attachments: [] };
    },
    async authenticateUserByName() {
      return { accessToken: "t", userId: "u" };
    },
    async getPlaybackInfo() {
      return { url: "http://x", playMethod: "DirectStream" as const, mediaSourceId: null, playSessionId: null };
    },
    async getIntroSkipperSegments() {
      return { intro: null, credits: null };
    },
    async getIntroAnalysisTaskId() {
      return null;
    },
    async getIntroScanStatus() {
      return true;
    },
    async runScheduledTask() {
      return false;
    },
    async isLibraryScanRunning() {
      return false;
    },
    async requestPlayback() {},
    async deleteItem(id: string) {
      state.deleted.push(id);
    },
    async refreshLibrary() {
      state.refreshed++;
    },
  };
}

describe("ResetService", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
    db.insert(users).values({ username: "admin", passwordHash: "x", preferences: {}, createdAt: 1 }).run();
    const anime = db.insert(animes).values({ anilistId: 1, titleRomaji: "Any Anime", status: "watching", createdAt: 1, updatedAt: 1 }).returning().get();
    const season = db.insert(seasons).values({ animeId: anime.id, number: 1 }).returning().get();
    db.insert(episodes).values({ seasonId: season.id, episodeNumber: 1 }).run();
  });

  it("removes Sonarr series WITHOUT deleting files, empties the root folder (kept on disk), purges Jellyfin, and wipes the app tables", async () => {
    const sonarr = fakeSonarr();
    const jellyfin = fakeJellyfin();
    const service = new ResetService(db, jellyfin, sonarr, "C:/reset-files", { settleDelayMs: 0 });

    const result = await service.reset();

    // deleteFiles must be FALSE — Sonarr must not remove files (that can take
    // the root folder directory with it). The folder is emptied separately.
    expect(sonarr.deleted).toEqual([
      { id: 21, deleteFiles: false },
      { id: 22, deleteFiles: false },
    ]);
    expect(result.files).toEqual({ success: true, empty: true });
    expect(jellyfin.deleted).toEqual(["jf-s1", "jf-s2"]);
    expect(jellyfin.refreshed).toBe(1);
    expect(result).toEqual({
      sonarr: { success: true, seriesDeleted: 2 },
      jellyfin: { success: true, itemsDeleted: 2 },
      db: { success: true, tables: expect.objectContaining({ users: 0, animes: 0, episodes: 0 }) },
      files: { success: true, empty: true },
    });
    expect(db.select().from(animes).all()).toHaveLength(0);
    expect(db.select().from(seasons).all()).toHaveLength(0);
    expect(db.select().from(episodes).all()).toHaveLength(0);
    expect(db.select().from(users).all()).toHaveLength(0);
    expect(db.select().from(playbackHistory).all()).toHaveLength(0);
    expect(db.select().from(malTokens).all()).toHaveLength(0);
    expect(db.select().from(trackPreferences).all()).toHaveLength(0);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });

  it("tolerates empty Sonarr and Jellyfin state and a missing root folder", async () => {
    const sonarr = fakeSonarr();
    sonarr.getSeries = async () => [];
    const jellyfin = fakeJellyfin();
    jellyfin.getSeries = async () => [];
    const service = new ResetService(db, jellyfin, sonarr, "C:/does-not-exist-for-test", { settleDelayMs: 0 });

    const result = await service.reset();

    expect(result.sonarr).toEqual({ success: true, seriesDeleted: 0 });
    expect(result.jellyfin).toEqual({ success: true, itemsDeleted: 0 });
    expect(result.files).toEqual({ success: true, empty: true });
    expect(db.select().from(animes).all()).toHaveLength(0);
  });

  it("continues past a Sonarr delete error (500 after removal)", async () => {
    const sonarr = fakeSonarr();
    sonarr.deleteSeries = async () => {
      throw new Error("Expected query to return 1 rows but returned 0");
    };
    const service = new ResetService(db, fakeJellyfin(), sonarr, "C:/reset-files", { settleDelayMs: 0 });

    const result = await service.reset();

    expect(result.sonarr).toEqual({ success: true, seriesDeleted: 2 });
    expect(db.select().from(animes).all()).toHaveLength(0);
  });

  it("reports files failure when the folder cannot be emptied", async () => {
    const sonarr = fakeSonarr();
    sonarr.getSeries = async () => [];
    const jellyfin = fakeJellyfin();
    jellyfin.getSeries = async () => [];
    const service = new ResetService(db, jellyfin, sonarr, "Z:/definitely-not-a-real-drive", { settleDelayMs: 0 });

    const result = await service.reset();

    expect(result.files.success).toBe(false);
    expect(result.files.empty).toBe(false);
  });
});
