import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { IntroAnalysisService } from "./intro-analysis-service";
import type { JellyfinClient, JellyfinSkipSegments } from "../integrations/types";

function seedAnime(db: Db): { animeId: number; seasonId: number; episodeId: number; itemId: string } {
  const anime = db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      titleRomaji: "Any Anime",
      status: "watching",
      jellyfinId: `jf-series-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: 1,
      updatedAt: 1,
    })
    .returning()
    .get();
  const season = db
    .insert(seasons)
    .values({ animeId: anime.id, number: 4 })
    .returning()
    .get();
  const itemId = "jf-ep-1";
  const episode = db
    .insert(episodes)
    .values({ seasonId: season.id, episodeNumber: 1, jellyfinItemId: itemId, available: true, progressSeconds: 0 })
    .returning()
    .get();
  return { animeId: anime.id, seasonId: season.id, episodeId: episode.id, itemId };
}

interface FakeJellyfinBehavior {
  segments?: JellyfinSkipSegments;
  scanBusy?: boolean;
  taskId?: string | null;
  acceptRun?: boolean;
}

function fakeJellyfin(
  behavior: FakeJellyfinBehavior = {},
): JellyfinClient & { segmentCalls: string[]; runCalls: string[] } {
  const state = {
    segmentCalls: [] as string[],
    runCalls: [] as string[],
  };
  return {
    get segmentCalls() {
      return state.segmentCalls;
    },
    get runCalls() {
      return state.runCalls;
    },
    async getIntroSkipperSegments(itemId: string): Promise<JellyfinSkipSegments> {
      state.segmentCalls.push(itemId);
      return behavior.segments ?? { intro: null, credits: null };
    },
    async getIntroScanStatus() {
      return behavior.scanBusy ?? false;
    },
    async getIntroAnalysisTaskId() {
      return behavior.taskId ?? null;
    },
    async runScheduledTask(taskId: string) {
      state.runCalls.push(taskId);
      return behavior.acceptRun ?? true;
    },
  } as unknown as JellyfinClient & { segmentCalls: string[]; runCalls: string[] };
}

describe("IntroAnalysisService.maybeTriggerForEpisode", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("runs the analysis task when the new episode has no segments", async () => {
    const { itemId } = seedAnime(db);
    const jellyfin = fakeJellyfin({ taskId: "intro-task" });
    const service = new IntroAnalysisService(db, jellyfin, "api-key", {
      cooldownMs: 0,
      now: () => 1_000,
    });

    const triggered = await service.maybeTriggerForEpisode(itemId);

    expect(triggered).toBe(true);
    expect(jellyfin.runCalls).toEqual(["intro-task"]);
  });

  it("skips episodes that already have intro or credits segments", async () => {
    const { itemId } = seedAnime(db);
    const jellyfin = fakeJellyfin({
      taskId: "intro-task",
      segments: { intro: { start: 28, end: 119 }, credits: null },
    });
    const service = new IntroAnalysisService(db, jellyfin, "api-key", { cooldownMs: 0 });

    const triggered = await service.maybeTriggerForEpisode(itemId);

    expect(triggered).toBe(false);
    expect(jellyfin.runCalls).toHaveLength(0);
  });

  it("coalesces repeated triggers for the same season within the cooldown", async () => {
    const { itemId, seasonId } = seedAnime(db);
    const itemId2 = "jf-ep-2";
    db.insert(episodes)
      .values({ seasonId, episodeNumber: 2, jellyfinItemId: itemId2, available: true, progressSeconds: 0 })
      .run();
    const jellyfin = fakeJellyfin({ taskId: "intro-task" });
    const service = new IntroAnalysisService(db, jellyfin, "api-key", {
      cooldownMs: 10 * 60 * 1000,
      now: () => 5_000,
    });

    await service.maybeTriggerForEpisode(itemId);
    const second = await service.maybeTriggerForEpisode(itemId2);

    expect(second).toBe(false);
    expect(jellyfin.runCalls).toHaveLength(1);
  });

  it("does not trigger while another scan is running", async () => {
    const { itemId } = seedAnime(db);
    const jellyfin = fakeJellyfin({ taskId: "intro-task", scanBusy: true });
    const service = new IntroAnalysisService(db, jellyfin, "api-key", { cooldownMs: 0 });

    const triggered = await service.maybeTriggerForEpisode(itemId);

    expect(triggered).toBe(false);
    expect(jellyfin.runCalls).toHaveLength(0);
  });

  it("bails when the anime is not linked to a Jellyfin series", async () => {
    const { itemId, animeId } = seedAnime(db);
    db.update(animes).set({ jellyfinId: null }).where(eq(animes.id, animeId)).run();
    const jellyfin = fakeJellyfin({ taskId: "intro-task" });
    const service = new IntroAnalysisService(db, jellyfin, "api-key", { cooldownMs: 0 });

    const triggered = await service.maybeTriggerForEpisode(itemId);

    expect(triggered).toBe(false);
    expect(jellyfin.runCalls).toHaveLength(0);
  });

  it("bails when the plugin task does not exist", async () => {
    const { itemId } = seedAnime(db);
    const jellyfin = fakeJellyfin({ taskId: null });
    const service = new IntroAnalysisService(db, jellyfin, "api-key", { cooldownMs: 0 });

    const triggered = await service.maybeTriggerForEpisode(itemId);

    expect(triggered).toBe(false);
    expect(jellyfin.runCalls).toHaveLength(0);
  });
});
