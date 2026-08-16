import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes, trackPreferences, users } from "../db/schema";
import { PlaybackService, EpisodeNotAvailableError } from "./playback-service";
import type { JellyfinClient, JellyfinAuth, JellyfinMediaStream, JellyfinMediaSource, JellyfinPlaybackInfo, JellyfinSkipSegments } from "../integrations/types";

function seedWatchableEpisode(
  db: Db,
  overrides: Partial<typeof episodes.$inferInsert> = {},
): { episodeId: number; animeId: number } {
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

function fakeJellyfin(): JellyfinClient & {
  authCalls: { username: string; password: string }[];
  playbackInfoCalls: { itemId: string; userId: string; startPositionTicks: number; audioStreamIndex?: number; subtitleStreamIndex?: number }[];
  streams: JellyfinMediaStream[];
  attachments: { index: number; codec: string | null; fileName: string | null; mimeType: string | null }[];
  mediaSourceId: string;
} {
  const authCalls: { username: string; password: string }[] = [];
  const playbackInfoCalls: { itemId: string; userId: string; startPositionTicks: number; audioStreamIndex?: number; subtitleStreamIndex?: number }[] = [];
  return {
    authCalls,
    playbackInfoCalls,
    streams: [],
    attachments: [],
    mediaSourceId: "ms-1",
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
      return this.streams;
    },
    async getMediaSource(): Promise<JellyfinMediaSource> {
      return {
        mediaSourceId: this.mediaSourceId,
        streams: this.streams,
        attachments: this.attachments,
      };
    },
    async authenticateUserByName(username: string, password: string): Promise<JellyfinAuth> {
      authCalls.push({ username, password });
      return { accessToken: "user-token", userId: "service-user-id" };
    },
    async getPlaybackInfo(itemId: string, userId: string, accessToken: string, startPositionTicks: number, audioStreamIndex?: number, subtitleStreamIndex?: number): Promise<JellyfinPlaybackInfo> {
      playbackInfoCalls.push({ itemId, userId, startPositionTicks, audioStreamIndex, subtitleStreamIndex });
      return {
        url: "http://localhost:8096/Videos/jf-ep-1/stream.m3u8?ApiKey=" + accessToken,
        playMethod: "Transcode",
        mediaSourceId: "ms-1",
        playSessionId: "ps-1",
      };
    },
    async getIntroSkipperSegments(): Promise<JellyfinSkipSegments> {
      return { intro: null, credits: null };
    },
    async requestPlayback() {},
    async deleteItem() {},
    async refreshLibrary() {},

  };
}

describe("PlaybackService.startPlayback", () => {
  let db: Db;
  let service: PlaybackService;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("resolves the episode, authenticates, and returns a playable URL", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(jellyfin.authCalls).toEqual([{ username: "epic", password: "secret" }]);
    expect(jellyfin.playbackInfoCalls).toEqual([
      {
        itemId: "jf-ep-1",
        userId: "service-user-id",
        startPositionTicks: 0,
        audioStreamIndex: undefined,
        subtitleStreamIndex: undefined,
      },
    ]);
    expect(result).toMatchObject({
      url: "http://localhost:8096/Videos/jf-ep-1/stream.m3u8?ApiKey=user-token",
      startPositionTicks: 0,
    });
  });

  it("passes resume ticks into the PlaybackInfo request", async () => {
    const { episodeId } = seedWatchableEpisode(db, { progressSeconds: 1220 });
    const jellyfin = fakeJellyfin();
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId, { resume: true });

    expect(jellyfin.playbackInfoCalls[0]!.startPositionTicks).toBe(12_200_000_000);
    expect(result.startPositionTicks).toBe(12_200_000_000);
  });

  it("starts from zero for a completed episode even when resume is requested", async () => {
    const { episodeId } = seedWatchableEpisode(db, { watched: true, progressSeconds: 1220 });
    const jellyfin = fakeJellyfin();
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId, { resume: true });

    expect(jellyfin.playbackInfoCalls[0]!.startPositionTicks).toBe(0);
  });

  it("refuses an episode with no Jellyfin item", async () => {
    const { episodeId } = seedWatchableEpisode(db, { jellyfinItemId: null, available: false });
    const jellyfin = fakeJellyfin();
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await expect(service.startPlayback(episodeId)).rejects.toThrow(EpisodeNotAvailableError);
    expect(jellyfin.authCalls).toHaveLength(0);
  });

  it("passes matched track indexes into the PlaybackInfo request when preferences exist", async () => {
    const { episodeId, animeId } = seedWatchableEpisode(db);
    const userId = db
      .insert(users)
      .values({ username: "admin", passwordHash: "x", preferences: {}, createdAt: 1 })
      .returning()
      .get().id;
    db.insert(trackPreferences).values({
      animeId,
      userId,
      audioLanguage: "jpn",
      subtitleLanguage: "spa",
      subtitleForced: true,
    }).run();
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 0, type: "Audio", codec: "aac", language: "eng", isForced: false, isDefault: true, displayTitle: null },
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: false, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "subrip", language: "spa", isForced: true, isDefault: false, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId, { resume: true, userId });

    expect(jellyfin.playbackInfoCalls[0]!.audioStreamIndex).toBe(1);
  });

  it("applies the default jpn audio preference when nothing is saved", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 0, type: "Audio", codec: "aac", language: "eng", isForced: false, isDefault: true, displayTitle: null },
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: false, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId);

    expect(jellyfin.playbackInfoCalls[0]!.audioStreamIndex).toBe(1);
  });

  it("exposes audio tracks with language, codec and display title", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: "Japanese" },
      { index: 2, type: "Audio", codec: "aac", language: "spa", isForced: false, isDefault: false, displayTitle: "Spanish" },
      { index: 3, type: "Subtitle", codec: "ass", language: "spa", isForced: false, isDefault: true, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.audioTracks).toEqual([
      { index: 1, language: "jpn", codec: "aac", displayTitle: "Japanese" },
      { index: 2, language: "spa", codec: "aac", displayTitle: "Spanish" },
    ]);
    expect(result.selectedAudioIndex).toBe(1);
  });

  it("honours an explicit audio index override", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId, { resume: false, audioStreamIndex: 1 });

    expect(jellyfin.playbackInfoCalls[0]!.audioStreamIndex).toBe(1);
  });

  it("exposes text subtitle tracks with delivery URLs and excludes image subtitles", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "ass", language: "eng", isForced: false, isDefault: true, displayTitle: "English" },
      { index: 3, type: "Subtitle", codec: "subrip", language: "spa", isForced: false, isDefault: false, displayTitle: "Spanish" },
      { index: 4, type: "Subtitle", codec: "pgs", language: "eng", isForced: false, isDefault: false, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.subtitleTracks).toEqual([
      {
        index: 2,
        language: "eng",
        codec: "ass",
        isForced: false,
        isDefault: true,
        displayTitle: "English",
        deliveryUrl: "http://localhost:8096/Videos/jf-ep-1/ms-1/Subtitles/2/0/Stream.ass?ApiKey=user-token",
      },
      {
        index: 3,
        language: "spa",
        codec: "subrip",
        isForced: false,
        isDefault: false,
        displayTitle: "Spanish",
        deliveryUrl: "http://localhost:8096/Videos/jf-ep-1/ms-1/Subtitles/3/0/Stream.srt?ApiKey=user-token",
      },
    ]);
  });

  it("exposes font attachments with delivery URLs", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.attachments = [{ index: 0, codec: "ttf", fileName: "Arial.ttf", mimeType: "font/ttf" }];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.fontAttachments).toEqual([
      {
        index: 0,
        fileName: "Arial.ttf",
        mimeType: "font/ttf",
        deliveryUrl: "http://localhost:8096/Videos/jf-ep-1/ms-1/Attachments/0?ApiKey=user-token",
      },
    ]);
  });

  it("selects the English subtitle track by default", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 2, type: "Subtitle", codec: "ass", language: "eng", isForced: false, isDefault: true, displayTitle: null },
      { index: 3, type: "Subtitle", codec: "ass", language: "spa", isForced: false, isDefault: false, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.selectedSubtitleIndex).toBe(2);
  });

  it("sets selectedSubtitleIndex to null when the episode has no text subtitle", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.selectedSubtitleIndex).toBeNull();
    expect(result.subtitleTracks).toEqual([]);
  });

  it("requests burn-in when the episode has only image subtitles", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 3, type: "Subtitle", codec: "pgs", language: "eng", isForced: false, isDefault: true, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId);

    expect(jellyfin.playbackInfoCalls[0]!.subtitleStreamIndex).toBe(3);
  });

  it("does not request burn-in when the episode has text subtitles", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "ass", language: "eng", isForced: false, isDefault: true, displayTitle: null },
      { index: 3, type: "Subtitle", codec: "pgs", language: "eng", isForced: false, isDefault: false, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId);

    expect(jellyfin.playbackInfoCalls[0]!.subtitleStreamIndex).toBeUndefined();
  });

  it("exposes intro and credits skip segments from the Intro Skipper plugin", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.getIntroSkipperSegments = async () => ({
      intro: { start: 28, end: 119.04 },
      credits: { start: 1420, end: 1514.99 },
    });
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.skipSegments).toEqual({
      intro: { start: 28, end: 119.04 },
      credits: { start: 1420, end: 1514.99 },
    });
  });

  it("returns empty skip segments when the plugin has no data", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.skipSegments).toEqual({ intro: null, credits: null });
  });

  it("still starts playback when the skip segment request fails", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.getIntroSkipperSegments = async () => {
      throw new Error("Intro Skipper plugin not installed");
    };
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.url).toContain("stream.m3u8");
    expect(result.skipSegments).toEqual({ intro: null, credits: null });
  });

  it("exposes the next episode id and number for the continue button", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get()!;
    const next = db
      .insert(episodes)
      .values({
        seasonId: episode.seasonId,
        episodeNumber: 2,
        jellyfinItemId: "jf-ep-2",
        available: true,
        progressSeconds: 0,
      })
      .returning()
      .get();
    const jellyfin = fakeJellyfin();
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.nextEpisodeId).toBe(next.id);
    expect(result.nextEpisodeNumber).toBe(2);
  });

  it("leaves the next episode fields null on the last episode", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.nextEpisodeId).toBeNull();
    expect(result.nextEpisodeNumber).toBeNull();
  });
});

