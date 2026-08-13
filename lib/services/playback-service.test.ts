import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes, trackPreferences, users } from "../db/schema";
import { PlaybackService, EpisodeNotAvailableError } from "./playback-service";
import type { JellyfinClient, JellyfinAuth, JellyfinMediaStream, JellyfinMediaSource, JellyfinPlaybackInfo } from "../integrations/types";

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
  playbackInfoCalls: { itemId: string; userId: string; startPositionTicks: number; audioStreamIndex?: number; subtitleStreamIndex?: number; burnInSubtitles?: boolean }[];
  streams: JellyfinMediaStream[];
  attachments: { index: number; codec: string | null; fileName: string | null; mimeType: string | null }[];
  mediaSourceId: string;
} {
  const authCalls: { username: string; password: string }[] = [];
  const playbackInfoCalls: { itemId: string; userId: string; startPositionTicks: number; audioStreamIndex?: number; subtitleStreamIndex?: number; burnInSubtitles?: boolean }[] = [];
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
    async getPlaybackInfo(itemId: string, userId: string, accessToken: string, startPositionTicks: number, audioStreamIndex?: number, subtitleStreamIndex?: number, burnInSubtitles?: boolean): Promise<JellyfinPlaybackInfo> {
      playbackInfoCalls.push({ itemId, userId, startPositionTicks, audioStreamIndex, subtitleStreamIndex, burnInSubtitles });
      return {
        url: "http://localhost:8096/Videos/jf-ep-1/stream.m3u8?ApiKey=" + accessToken,
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
        burnInSubtitles: false,
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
    expect(jellyfin.playbackInfoCalls[0]!.subtitleStreamIndex).toBeUndefined();
    expect(jellyfin.playbackInfoCalls[0]!.burnInSubtitles).toBe(false);
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

  it("exposes text subtitle tracks with client-fetchable URLs", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "ass", language: "spa", isForced: false, isDefault: true, displayTitle: "Spanish ASS" },
      { index: 3, type: "Subtitle", codec: "pgs", language: "eng", isForced: false, isDefault: false, displayTitle: "English PGS" },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    const spa = result.subtitleTracks.find((t) => t.index === 2);
    const eng = result.subtitleTracks.find((t) => t.index === 3);
    expect(spa).toMatchObject({
      index: 2,
      isText: true,
      language: "spa",
      displayTitle: "Spanish ASS",
    });
    expect(spa!.url).toContain("/Videos/jf-ep-1/ms-1/Subtitles/2/0/Stream.ass?ApiKey=");
    expect(eng).toMatchObject({ index: 3, isText: false, url: null });
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

  it("does not burn in text subtitles and skips the subtitle index", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "ass", language: "spa", isForced: false, isDefault: true, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId, { resume: false, subtitleStreamIndex: 2 });

    expect(jellyfin.playbackInfoCalls[0]!.burnInSubtitles).toBe(false);
    expect(jellyfin.playbackInfoCalls[0]!.subtitleStreamIndex).toBeUndefined();
    expect(result.selectedSubtitleIndex).toBe(2);
  });

  it("burns in image subtitles and passes the subtitle index", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "pgs", language: "eng", isForced: false, isDefault: true, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId, { resume: false, subtitleStreamIndex: 2 });

    expect(jellyfin.playbackInfoCalls[0]!.burnInSubtitles).toBe(true);
    expect(jellyfin.playbackInfoCalls[0]!.subtitleStreamIndex).toBe(2);
  });

  it("honours explicit audio and subtitle index overrides", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "ass", language: "eng", isForced: false, isDefault: true, displayTitle: null },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    await service.startPlayback(episodeId, { resume: false, audioStreamIndex: 1, subtitleStreamIndex: 2 });

    expect(jellyfin.playbackInfoCalls[0]!.audioStreamIndex).toBe(1);
    expect(jellyfin.playbackInfoCalls[0]!.subtitleStreamIndex).toBeUndefined();
  });

  it("returns embedded font attachment URLs for text-subtitle tracks", async () => {
    const { episodeId } = seedWatchableEpisode(db);
    const jellyfin = fakeJellyfin();
    jellyfin.streams = [
      { index: 1, type: "Audio", codec: "aac", language: "jpn", isForced: false, isDefault: true, displayTitle: null },
      { index: 2, type: "Subtitle", codec: "ass", language: "spa", isForced: false, isDefault: true, displayTitle: null },
    ];
    jellyfin.attachments = [
      { index: 17, codec: "ttf", fileName: "arial.ttf", mimeType: "application/x-truetype-font" },
      { index: 18, codec: "otf", fileName: "adobe.otf", mimeType: "application/x-truetype-font" },
      { index: 19, codec: "notfont", fileName: "x.png", mimeType: "image/png" },
    ];
    service = new PlaybackService(db, jellyfin, {
      jellyfinUrl: "http://localhost:8096",
      serviceUsername: "epic",
      servicePassword: "secret",
    });

    const result = await service.startPlayback(episodeId);

    expect(result.fontUrls).toEqual([
      "http://localhost:8096/Videos/jf-ep-1/ms-1/Attachments/17?ApiKey=user-token",
      "http://localhost:8096/Videos/jf-ep-1/ms-1/Attachments/18?ApiKey=user-token",
    ]);
  });
});

