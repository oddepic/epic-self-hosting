import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { animes } from "../db/schema";
import { reconcileAvailability } from "./availability-reconciliation-service";
import type { JellyfinClient, SonarrClient } from "../integrations/types";

function fakeJellyfin(): JellyfinClient {
  return {
    async getSeries() {
      // A non-empty library avoids the sync self-heal 15s sleep in tests.
      return [{ id: "jf-s", tvdbId: null, title: "Any Anime" }];
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
    async deleteItem() {},
    async refreshLibrary() {},
  };
}

function fakeSonarr(rescanSeries: (seriesId: number) => void): SonarrClient {
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
    async setEpisodesMonitored() {},
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
    async rescanSeries(seriesId: number) {
      rescanSeries(seriesId);
      return { id: 42 };
    },
    async getCommandStatus() {
      return "completed";
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

describe("reconcileAvailability", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("rescans every Sonarr-linked series before syncing when requested", async () => {
    const rescanCalls: number[] = [];
    db.insert(animes)
      .values({
        anilistId: 1,
        sonarrId: 35,
        titleRomaji: "Any Anime",
        status: "watching",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(animes)
      .values({
        anilistId: 2,
        sonarrId: 36,
        titleRomaji: "Another Anime",
        status: "watching",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    db.insert(animes)
      .values({
        anilistId: 3,
        sonarrId: null,
        titleRomaji: "Not Linked",
        status: "watching",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    const result = await reconcileAvailability(db, fakeJellyfin(), fakeSonarr((id) => rescanCalls.push(id)), {
      rescanSonarr: true,
    });

    expect(rescanCalls).toEqual([35, 36]);
    expect(result.sonarrRescanned).toBe(2);
  });

  it("does not rescan when the option is off", async () => {
    const rescanCalls: number[] = [];
    db.insert(animes)
      .values({
        anilistId: 1,
        sonarrId: 35,
        titleRomaji: "Any Anime",
        status: "watching",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    const result = await reconcileAvailability(db, fakeJellyfin(), fakeSonarr((id) => rescanCalls.push(id)));

    expect(rescanCalls).toEqual([]);
    expect(result.sonarrRescanned).toBe(0);
  });
});
