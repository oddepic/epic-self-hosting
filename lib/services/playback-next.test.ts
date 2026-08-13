import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { PlaybackService } from "./playback-service";
import type { JellyfinClient, JellyfinAuth, JellyfinPlaybackInfo } from "../integrations/types";

function seedSeries(db: Db, episodeCount = 3): { animeId: number; episodeIds: number[] } {
  const anime = db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      titleRomaji: "Any Anime",
      titleEnglish: "Any Anime",
      status: "watching",
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
  const ids: number[] = [];
  for (let n = 1; n <= episodeCount; n++) {
    const ep = db
      .insert(episodes)
      .values({
        seasonId: season.id,
        episodeNumber: n,
        jellyfinItemId: `jf-ep-${n}`,
        available: true,
        progressSeconds: 0,
      })
      .returning()
      .get();
    ids.push(ep.id);
  }
  return { animeId: anime.id, episodeIds: ids };
}

function fakeJellyfin(): JellyfinClient {
  return {
    async getSeries() {
      return [];
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
    async authenticateUserByName(_username: string, _password: string): Promise<JellyfinAuth> {
      return { accessToken: "user-token", userId: "service-user-id" };
    },
    async getPlaybackInfo(itemId: string, _userId: string, accessToken: string): Promise<JellyfinPlaybackInfo> {
      return {
        url: `http://localhost:8096/Videos/${itemId}/stream.m3u8?ApiKey=${accessToken}`,
        playMethod: "Transcode",
        mediaSourceId: "ms-1",
        playSessionId: "ps-1",
      };
    },
    async requestPlayback() {},
    async listAllItemIds() {
      return [];
    },
    async deleteItem() {},
    async refreshLibrary() {},
  };
}

describe("PlaybackService.getNextAvailableEpisode", () => {
  let db: Db;
  let service: PlaybackService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new PlaybackService(db, fakeJellyfin(), {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });
  });

  it("returns the next available episode in order", () => {
    const { episodeIds } = seedSeries(db);
    expect(service.getNextAvailableEpisode(episodeIds[0]!)).toBe(episodeIds[1]);
    expect(service.getNextAvailableEpisode(episodeIds[1]!)).toBe(episodeIds[2]);
  });

  it("returns null for the last episode", () => {
    const { episodeIds } = seedSeries(db);
    expect(service.getNextAvailableEpisode(episodeIds[2]!)).toBeNull();
  });

  it("skips unavailable episodes", () => {
    const { episodeIds } = seedSeries(db);
    db.update(episodes).set({ available: false }).where(eq(episodes.id, episodeIds[1]!)).run();
    expect(service.getNextAvailableEpisode(episodeIds[0]!)).toBe(episodeIds[2]);
  });

  it("returns null when the episode is unknown", () => {
    expect(service.getNextAvailableEpisode(999_999)).toBeNull();
  });

  it("returns display context alongside the stream", async () => {
    const { episodeIds, animeId } = seedSeries(db);
    db.update(animes).set({ titleRomaji: "Any Anime", titleEnglish: "Any Anime" }).where(eq(animes.id, animeId)).run();
    const result = await service.startPlayback(episodeIds[0]!);
    expect(result).toMatchObject({
      episodeId: episodeIds[0],
      seasonNumber: 1,
      episodeNumber: 1,
      animeTitle: "Any Anime",
      nextEpisodeId: episodeIds[1],
    });
  });

  it("walks across seasons in order", () => {
    const anime = db
      .insert(animes)
      .values({
        anilistId: Math.floor(Math.random() * 1_000_000),
        titleRomaji: "Any Anime",
        titleEnglish: "Any Anime",
        status: "watching",
        createdAt: 1,
        updatedAt: 1,
      })
      .returning()
      .get();
    const season1 = db
      .insert(seasons)
      .values({ animeId: anime.id, number: 1 })
      .returning()
      .get();
    const s1e1 = db
      .insert(episodes)
      .values({ seasonId: season1.id, episodeNumber: 1, jellyfinItemId: "jf-s1e1", available: true })
      .returning()
      .get();
    const season2 = db
      .insert(seasons)
      .values({ animeId: anime.id, number: 2 })
      .returning()
      .get();
    const s2e1 = db
      .insert(episodes)
      .values({ seasonId: season2.id, episodeNumber: 1, jellyfinItemId: "jf-s2e1", available: true })
      .returning()
      .get();
    expect(service.getNextAvailableEpisode(s1e1.id)).toBe(s2e1.id);
  });
});
