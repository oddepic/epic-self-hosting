import { Jellyfin, Api } from "@jellyfin/sdk";
import { DlnaProfileType } from "@jellyfin/sdk/lib/generated-client/models/dlna-profile-type";
import { MediaStreamProtocol } from "@jellyfin/sdk/lib/generated-client/models/media-stream-protocol";
import { SubtitleDeliveryMethod } from "@jellyfin/sdk/lib/generated-client/models/subtitle-delivery-method";
import { getUserApi } from "@jellyfin/sdk/lib/utils/api/user-api";
import { getUserLibraryApi } from "@jellyfin/sdk/lib/utils/api/user-library-api";
import { getMediaInfoApi } from "@jellyfin/sdk/lib/utils/api/media-info-api";
import type { JellyfinClient, JellyfinAuth, JellyfinEpisodeItem, JellyfinMediaStream, JellyfinMediaSource, JellyfinPlaybackInfo, JellyfinSeriesItem, JellyfinSession } from "./types";

interface JellyfinItemDto {
  Id: string;
  Name?: string;
  ProviderIds?: Record<string, string>;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ImageTags?: { Primary?: string };
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number };
}

interface JellyfinSessionDto {
  Id: string;
  Client?: string;
  DeviceName?: string;
  UserId?: string;
}

let cachedServiceAuth: { accessToken: string; userId: string; mintedAt: number } | null = null;

const SERVICE_TOKEN_TTL_MS = 55 * 60 * 1000;

// Jellyfin invalidates a user's previous token when a new AuthenticateByName
// is issued for the same user. Two concurrent playback starts (e.g. the page
// effect double-firing after a dev-server restart) must mint ONE token and
// share it — otherwise the second mint kills the first URL's token → 401.
let authInFlight: Promise<JellyfinAuth> | null = null;

function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: { status?: number } }).response?.status === "number" &&
    (error as { response: { status: number } }).response.status === 401
  );
}

export const WEB_DEVICE_PROFILE = {
  MaxStreamingBitrate: 120_000_000,
  DirectPlayProfiles: [
    { Container: "mp4", VideoCodec: "h264", AudioCodec: "aac", Type: DlnaProfileType.Video },
    { Container: "webm", VideoCodec: "vp8,vp9,av1", AudioCodec: "opus,vorbis", Type: DlnaProfileType.Video },
  ],
  TranscodingProfiles: [
    {
      Container: "ts",
      Type: DlnaProfileType.Video,
      AudioCodec: "aac",
      VideoCodec: "h264",
      Protocol: MediaStreamProtocol.Hls,
      EnableSubtitlesInManifest: false,
    },
  ],
  SubtitleProfiles: [
    { Format: "ass", Method: SubtitleDeliveryMethod.External },
    { Format: "ssa", Method: SubtitleDeliveryMethod.External },
    { Format: "srt", Method: SubtitleDeliveryMethod.External },
    { Format: "subrip", Method: SubtitleDeliveryMethod.External },
  ],
};

export class JellyfinSdkClient implements JellyfinClient {
  private readonly api: Api;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    clientInfo: { name: string; version: string },
    deviceInfo: { name: string; id: string },
  ) {
    this.api = new Jellyfin({
      clientInfo,
      deviceInfo,
    }).createApi(baseUrl, apiKey);
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.api.basePath}${path}`, {
      ...options,
      headers: {
        "X-Emby-Token": this.apiKey,
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Jellyfin responded ${response.status} for ${path}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async authenticateUserByName(username: string, password: string): Promise<JellyfinAuth> {
    if (cachedServiceAuth && Date.now() - cachedServiceAuth.mintedAt < SERVICE_TOKEN_TTL_MS) {
      return { accessToken: cachedServiceAuth.accessToken, userId: cachedServiceAuth.userId };
    }
    if (authInFlight) return authInFlight;
    authInFlight = (async () => {
      const userApi = getUserApi(this.api);
      const { data } = await userApi.authenticateUserByName({
        authenticateUserByName: { Username: username, Pw: password },
      });
      if (!data.AccessToken || !data.User?.Id) {
        throw new Error("Jellyfin authentication failed");
      }
      cachedServiceAuth = {
        accessToken: data.AccessToken,
        userId: data.User.Id,
        mintedAt: Date.now(),
      };
      return { accessToken: data.AccessToken, userId: data.User.Id };
    })().finally(() => {
      authInFlight = null;
    });
    return authInFlight;
  }

  async getPlaybackInfo(
    itemId: string,
    userId: string,
    accessToken: string,
    startPositionTicks: number,
    audioStreamIndex?: number,
    subtitleStreamIndex?: number,
  ): Promise<JellyfinPlaybackInfo> {
    return this.withFreshAuth(accessToken, async (token) => {
      const api = new Jellyfin({
        clientInfo: { name: "epic self-hosting", version: "0.1.0" },
        deviceInfo: { name: "browser", id: "epic-self-hosting-player" },
      }).createApi(this.api.basePath, token);

      const { data } = await getMediaInfoApi(api).getPostedPlaybackInfo({
        itemId,
        userId,
        startTimeTicks: startPositionTicks,
        audioStreamIndex,
        playbackInfoDto: {
          UserId: userId,
          StartTimeTicks: startPositionTicks,
          DeviceProfile: WEB_DEVICE_PROFILE,
          EnableDirectPlay: true,
          EnableDirectStream: true,
          EnableTranscoding: true,
          ...(subtitleStreamIndex !== undefined
            ? { SubtitleStreamIndex: subtitleStreamIndex, AlwaysBurnInSubtitleWhenTranscoding: true }
            : {}),
        },
      });

      const source = data.MediaSources?.[0];
      if (!source) {
        throw new Error("Jellyfin returned no media sources");
      }

      const url = source.TranscodingUrl
        ? `${this.api.basePath}${source.TranscodingUrl}`
        : this.buildDirectUrl(itemId, source.Id, source.Container, token, source.ETag ?? null);

      return {
        url,
        playMethod: source.TranscodingUrl ? "Transcode" : "DirectStream",
        mediaSourceId: source.Id ?? null,
        playSessionId: data.PlaySessionId ?? null,
      };
    });
  }

  private buildDirectUrl(
    itemId: string,
    mediaSourceId: string | null | undefined,
    container: string | null | undefined,
    token: string,
    etag: string | null,
  ): string {
    const params = new URLSearchParams({
      Static: "true",
      mediaSourceId: mediaSourceId ?? itemId,
      deviceId: "epic-self-hosting-player",
      ApiKey: token,
    });
    if (etag) params.set("Tag", etag);
    return `${this.api.basePath}/Videos/${itemId}/stream.${container ?? "mp4"}?${params.toString()}`;
  }

  async getMediaStreams(itemId: string, accessToken: string): Promise<JellyfinMediaStream[]> {
    return this.withFreshAuth(accessToken, async (token) => {
      const api = new Jellyfin({
        clientInfo: { name: "epic self-hosting", version: "0.1.0" },
        deviceInfo: { name: "browser", id: "epic-self-hosting-player" },
      }).createApi(this.api.basePath, token);
      const { data } = await getUserLibraryApi(api).getItem({ itemId });
      const source = data.MediaSources?.[0];
      return (source?.MediaStreams ?? [])
        .filter((s) => s.Type === "Audio" || s.Type === "Subtitle")
        .map((s) => ({
          index: s.Index ?? 0,
          type: (s.Type === "Audio" ? "Audio" : "Subtitle") as JellyfinMediaStream["type"],
          codec: s.Codec ?? null,
          language: s.Language ?? null,
          isForced: s.IsForced ?? false,
          isDefault: s.IsDefault ?? false,
          displayTitle: s.DisplayTitle ?? null,
        }));
    });
  }

  async getMediaSource(itemId: string, accessToken: string): Promise<JellyfinMediaSource> {
    return this.withFreshAuth(accessToken, async (token) => {
      const api = new Jellyfin({
        clientInfo: { name: "epic self-hosting", version: "0.1.0" },
        deviceInfo: { name: "browser", id: "epic-self-hosting-player" },
      }).createApi(this.api.basePath, token);
      const { data } = await getUserLibraryApi(api).getItem({ itemId });
      const source = data.MediaSources?.[0];
      const mapStream = (s: {
        Index?: number;
        Type?: string;
        Codec?: string | null;
        Language?: string | null;
        IsForced?: boolean;
        IsDefault?: boolean;
        DisplayTitle?: string | null;
      }): JellyfinMediaStream => ({
        index: s.Index ?? 0,
        type: (s.Type === "Audio" ? "Audio" : s.Type === "Subtitle" ? "Subtitle" : "Video") as JellyfinMediaStream["type"],
        codec: s.Codec ?? null,
        language: s.Language ?? null,
        isForced: s.IsForced ?? false,
        isDefault: s.IsDefault ?? false,
        displayTitle: s.DisplayTitle ?? null,
      });
      return {
        mediaSourceId: source?.Id ?? null,
        streams: (source?.MediaStreams ?? []).map(mapStream),
        attachments: (source?.MediaAttachments ?? []).map((a) => ({
          index: a.Index ?? 0,
          codec: a.Codec ?? null,
          fileName: a.FileName ?? null,
          mimeType: a.MimeType ?? null,
        })),
      };
    });
  }

  private async withFreshAuth<T>(
    token: string,
    fn: (freshToken: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(token);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      console.error("[playback] 401 on Jellyfin service call — refreshing service token");
      cachedServiceAuth = null;
      const fresh = await this.authenticateUserByName(
        process.env.JELLYFIN_SERVICE_USERNAME ?? "",
        process.env.JELLYFIN_SERVICE_PASSWORD ?? "",
      );
      return fn(fresh.accessToken);
    }
  }

  private tvdbIdOf(item: JellyfinItemDto): number | null {
    const ids = item.ProviderIds ?? {};
    const raw = ids.Tvdb ?? ids.tvdb;
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async getSeries(): Promise<JellyfinSeriesItem[]> {
    const body = await this.request<{ Items: JellyfinItemDto[] }>(
      "/Items?Recursive=true&IncludeItemTypes=Series&Fields=ProviderIds",
    );
    return (body.Items ?? []).map((item) => ({
      id: item.Id,
      tvdbId: this.tvdbIdOf(item),
      title: item.Name ?? null,
    }));
  }

  async listAllItemIds(): Promise<string[]> {
    const ids: string[] = [];
    const pageSize = 500;
    for (let start = 0; ; start += pageSize) {
      const body = await this.request<{ Items: JellyfinItemDto[]; TotalRecordCount?: number }>(
        `/Items?Recursive=true&Limit=${pageSize}&StartIndex=${start}`,
      );
      const items = body.Items ?? [];
      ids.push(...items.map((item) => item.Id));
      if (ids.length >= (body.TotalRecordCount ?? 0)) break;
    }
    return ids;
  }

  async deleteItem(id: string): Promise<void> {
    await this.request(`/Items/${id}`, { method: "DELETE" });
  }

  async refreshLibrary(): Promise<void> {
    await this.request("/Library/Refresh", { method: "POST" });
  }

  async getEpisodes(seriesId: string): Promise<JellyfinEpisodeItem[]> {
    const body = await this.request<{ Items: JellyfinItemDto[] }>(
      `/Shows/${seriesId}/Episodes?Fields=ProviderIds,PrimaryImageAspectRatio`,
    );
    return (body.Items ?? []).map((item) => ({
      id: item.Id,
      seasonNumber: item.ParentIndexNumber ?? null,
      episodeNumber: item.IndexNumber ?? null,
      name: item.Name ?? null,
      thumbnailUrl: item.ImageTags?.Primary
        ? `${this.api.basePath}/Items/${item.Id}/Images/Primary?maxWidth=320&quality=90`
        : null,
      userData: item.UserData
        ? {
            played: item.UserData.Played ?? false,
            positionTicks: item.UserData.PlaybackPositionTicks ?? 0,
          }
        : null,
    }));
  }

  async getSessions(): Promise<JellyfinSession[]> {
    const body = await this.request<JellyfinSessionDto[]>("/Sessions");
    return (body ?? []).map((s) => ({
      id: s.Id,
      client: s.Client ?? "unknown",
      deviceName: s.DeviceName ?? null,
      userId: s.UserId ?? null,
    }));
  }

  async requestPlayback(
    sessionId: string,
    itemId: string,
    startPositionTicks?: number,
  ): Promise<void> {
    const params = new URLSearchParams({
      playCommand: "PlayNow",
      itemIds: itemId,
      startPositionTicks: String(startPositionTicks ?? 0),
    });
    const response = await fetch(`${this.api.basePath}/Sessions/${sessionId}/Playing?${params.toString()}`, {
      method: "POST",
      headers: { "X-Emby-Token": this.apiKey },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Jellyfin playback command failed: ${response.status}`);
    }
  }
}
