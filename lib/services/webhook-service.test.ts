import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes, users, playbackHistory } from "../db/schema";
import { WebhookService } from "./webhook-service";
import type { JellyfinWebhookPayload } from "../integrations/types";

const SERVICE_USER_ID = "dec3365b-service-account";
const RUNTIME_TICKS = 14_400_000_000; // 1440 seconds
const RUNTIME_SECONDS = 1440;

function seedEpisode(
  db: Db,
  overrides: Partial<typeof episodes.$inferInsert> = {},
): { episodeId: number; animeId: number } {
  const anime = db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      titleRomaji: "Any Anime",
      titleEnglish: "Any Anime",
      status: "plan_to_watch",
      createdAt: 1,
      updatedAt: 1,
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
    .values({
      seasonId: season.id,
      episodeNumber: 1,
      jellyfinItemId: "jf-ep-1",
      available: true,
      progressSeconds: 0,
      ...overrides,
    })
    .returning()
    .get();
  return { episodeId: episode.id, animeId: anime.id };
}

function webhookPayload(overrides: Partial<JellyfinWebhookPayload> = {}): JellyfinWebhookPayload {
  return {
    NotificationType: "PlaybackStart",
    UserId: SERVICE_USER_ID,
    ItemId: "jf-ep-1",
    ItemType: "Episode",
    RunTimeTicks: RUNTIME_TICKS,
    PlaybackPositionTicks: 0,
    PlayedToCompletion: false,
    ...overrides,
  };
}

function makeService(
  db: Db,
  now: () => number = () => 100_000,
  throttleStore: Map<number, { time: number; position: number }> = new Map(),
): WebhookService {
  return new WebhookService(db, {
    webhookSecret: "secret-123",
    jellyfinUserId: SERVICE_USER_ID,
    defaultUserId: 1,
  }, now, throttleStore);
}

describe("WebhookService", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  describe("validateSecret", () => {
    it("accepts the configured secret", () => {
      const service = makeService(db);
      expect(service.validateSecret("secret-123")).toBe(true);
    });

    it("rejects a mismatched, missing, or empty secret", () => {
      const service = makeService(db);
      expect(service.validateSecret("wrong")).toBe(false);
      expect(service.validateSecret(null)).toBe(false);
      expect(service.validateSecret("")).toBe(false);
    });
  });

  describe("dispatch", () => {
    it("ignores events it does not handle", () => {
      const { episodeId } = seedEpisode(db, { progressSeconds: 500 });
      const service = makeService(db);
      service.handleEvent(webhookPayload({ NotificationType: "UserDataSaved" }));
      service.handleEvent(webhookPayload({ NotificationType: "AuthenticationFailure" }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(500);
      expect(episode!.available).toBe(true);
      expect(db.select().from(playbackHistory).all()).toHaveLength(0);
    });

    it("ignores playback events from Jellyfin users other than the mapped service account", () => {
      const { episodeId } = seedEpisode(db, { progressSeconds: 0 });
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        UserId: "some-other-user-id",
        NotificationType: "PlaybackStop",
        PlaybackPositionTicks: RUNTIME_TICKS,
        PlayedToCompletion: true,
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(0);
      expect(episode!.watched).toBe(false);
      expect(db.select().from(playbackHistory).all()).toHaveLength(0);
    });

    it("processes events regardless of UserId when no jellyfin user id is configured", () => {
      const { episodeId } = seedEpisode(db);
      const service = new WebhookService(db, {
        webhookSecret: "secret-123",
        jellyfinUserId: "",
        defaultUserId: 1,
      }, () => 100_000, new Map());

      service.handleEvent(webhookPayload({
        UserId: "some-other-user-id",
        NotificationType: "PlaybackProgress",
        PlaybackPositionTicks: 7_200_000_000,
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(720);
    });
  });

  describe("ItemAdded", () => {
    it("marks the episode available and never touches progress", () => {
      const { episodeId } = seedEpisode(db, { available: false, progressSeconds: 500 });
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "ItemAdded",
        PlaybackPositionTicks: undefined,
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.available).toBe(true);
      expect(episode!.progressSeconds).toBe(500);
      expect(episode!.watched).toBe(false);
    });

    it("is a no-op for unknown items and non-Episode item types", () => {
      const { episodeId } = seedEpisode(db, { available: false });
      const service = makeService(db);

      service.handleEvent(webhookPayload({ NotificationType: "ItemAdded", ItemId: "unknown-item" }));
      service.handleEvent(webhookPayload({
        NotificationType: "ItemAdded",
        ItemType: "Series",
        ItemId: "some-series-id",
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.available).toBe(false);
    });
  });

  describe("PlaybackStart", () => {
    it("preserves the watched state and resume position while marking the anime watching", () => {
      const { episodeId, animeId } = seedEpisode(db, { watched: true, progressSeconds: 500 });
      const service = makeService(db);

      service.handleEvent(webhookPayload({ NotificationType: "PlaybackStart" }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(500);
      expect(episode!.watched).toBe(true);
      const anime = db.select().from(animes).where(eq(animes.id, animeId)).get();
      expect(anime!.status).toBe("watching");
      expect(anime!.lastWatchedAt).toBe(100_000);
    });

    it("does not downgrade a completed anime to watching", () => {
      const { animeId } = seedEpisode(db);
      db.update(animes).set({ status: "completed" }).where(eq(animes.id, animeId)).run();
      const service = makeService(db);

      service.handleEvent(webhookPayload({ NotificationType: "PlaybackStart" }));

      const anime = db.select().from(animes).where(eq(animes.id, animeId)).get();
      expect(anime!.status).toBe("completed");
    });

    it("reports the anime id when its status changed to watching", () => {
      const { animeId } = seedEpisode(db);
      const service = makeService(db);

      const result = service.handleEvent(webhookPayload({ NotificationType: "PlaybackStart" }));

      expect(result.statusChangedAnimeIds).toEqual([animeId]);
      expect(result.completedEpisodeIds).toEqual([]);
    });

    it("reports no status change for an already completed anime", () => {
      const { animeId } = seedEpisode(db);
      db.update(animes).set({ status: "completed" }).where(eq(animes.id, animeId)).run();
      const service = makeService(db);

      const result = service.handleEvent(webhookPayload({ NotificationType: "PlaybackStart" }));

      expect(result.statusChangedAnimeIds).toEqual([]);
    });

    it("is a no-op for an unknown item", () => {
      const service = makeService(db);
      expect(() =>
        service.handleEvent(webhookPayload({ NotificationType: "PlaybackStart", ItemId: "unknown-item" })),
      ).not.toThrow();
    });
  });

  describe("PlaybackProgress", () => {
    it("stores the position in seconds and backfills the episode duration", () => {
      const { episodeId } = seedEpisode(db, { durationSeconds: null });
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackProgress",
        PlaybackPositionTicks: 7_200_000_000,
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(720);
      expect(episode!.durationSeconds).toBe(RUNTIME_SECONDS);
    });

    it("ignores progress for already watched episodes", () => {
      const { episodeId } = seedEpisode(db, { watched: true, progressSeconds: 0 });
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackProgress",
        PlaybackPositionTicks: 7_200_000_000,
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(0);
      expect(episode!.watched).toBe(true);
    });

    it("throttles writes within 15 seconds when the delta is under 5% of runtime", () => {
      const { episodeId } = seedEpisode(db);
      let fakeNow = 100_000;
      const service = makeService(db, () => fakeNow);

      service.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", PlaybackPositionTicks: 7_200_000_000 }));
      fakeNow += 10_000;
      service.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", PlaybackPositionTicks: 7_300_000_000 }));

      let episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(720);

      fakeNow += 10_000;
      service.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", PlaybackPositionTicks: 8_000_000_000 }));

      episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(800);
    });

    it("stores again once 15 seconds have passed even with a small delta", () => {
      const { episodeId } = seedEpisode(db);
      let fakeNow = 100_000;
      const service = makeService(db, () => fakeNow);

      service.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", PlaybackPositionTicks: 7_200_000_000 }));
      fakeNow += 20_000;
      service.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", PlaybackPositionTicks: 7_300_000_000 }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(730);
    });

    it("throttles across service instances sharing the same store", () => {
      const { episodeId } = seedEpisode(db);
      let fakeNow = 100_000;
      const store = new Map<number, { time: number; position: number }>();
      const first = makeService(db, () => fakeNow, store);

      first.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", PlaybackPositionTicks: 7_200_000_000 }));
      fakeNow += 10_000;
      const second = makeService(db, () => fakeNow, store);
      second.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", PlaybackPositionTicks: 7_300_000_000 }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(720);
    });

    it("is a no-op for an unknown item", () => {
      const service = makeService(db);
      expect(() =>
        service.handleEvent(webhookPayload({ NotificationType: "PlaybackProgress", ItemId: "unknown-item" })),
      ).not.toThrow();
    });
  });

  describe("PlaybackStop", () => {
    function seedUser(): number {
      return db
        .insert(users)
        .values({ username: "admin", passwordHash: "x", preferences: {}, createdAt: 1 })
        .returning()
        .get().id;
    }

    it("marks the episode watched and writes history when PlayedToCompletion is set", () => {
      seedUser();
      const { episodeId } = seedEpisode(db, { progressSeconds: 400 });
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackStop",
        PlaybackPositionTicks: RUNTIME_TICKS,
        PlayedToCompletion: true,
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.watched).toBe(true);
      expect(episode!.progressSeconds).toBe(0);
      const history = db.select().from(playbackHistory).all();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        episodeId,
        userId: 1,
        completed: true,
        positionSeconds: RUNTIME_SECONDS,
      });
    });

    it("marks the episode watched when the position is at or past 95% of runtime", () => {
      seedUser();
      const { episodeId } = seedEpisode(db);
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackStop",
        PlaybackPositionTicks: Math.floor(RUNTIME_TICKS * 0.95),
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.watched).toBe(true);
      expect(episode!.progressSeconds).toBe(0);
      expect(db.select().from(playbackHistory).all()).toHaveLength(1);
    });

    it("discards positions below 5% of runtime", () => {
      const { episodeId } = seedEpisode(db, { progressSeconds: 60 });
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackStop",
        PlaybackPositionTicks: Math.floor(RUNTIME_TICKS * 0.04),
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(60);
      expect(episode!.watched).toBe(false);
      expect(db.select().from(playbackHistory).all()).toHaveLength(0);
    });

    it("stores the final position for stops between 5% and 95%", () => {
      const { episodeId } = seedEpisode(db);
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackStop",
        PlaybackPositionTicks: 9_000_000_000,
      }));

      const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.progressSeconds).toBe(900);
      expect(episode!.watched).toBe(false);
      expect(db.select().from(playbackHistory).all()).toHaveLength(0);
    });

    it("falls back to the PlayedToCompletion flag when runtime is unknown", () => {
      seedUser();
      const { episodeId } = seedEpisode(db);
      const service = makeService(db);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackStop",
        RunTimeTicks: undefined,
        PlaybackPositionTicks: 13_900_000_000,
      }));

      let episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.watched).toBe(false);
      expect(episode!.progressSeconds).toBe(1390);

      service.handleEvent(webhookPayload({
        NotificationType: "PlaybackStop",
        RunTimeTicks: undefined,
        PlaybackPositionTicks: 13_900_000_000,
        PlayedToCompletion: true,
      }));

      episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
      expect(episode!.watched).toBe(true);
      const history = db.select().from(playbackHistory).all();
      expect(history[0]!.positionSeconds).toBe(1390);
    });
  });
});
