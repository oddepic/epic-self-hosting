import { and, eq, gt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons } from "../db/schema";
import type { JellyfinClient, JellyfinSkipSegments } from "../integrations/types";
import { TrackPreferenceService, isTextSubtitleCodec } from "./track-preference-service";

export class EpisodeNotAvailableError extends Error {
  constructor() {
    super("Episode is not available for playback");
  }
}

export interface AudioTrackInfo {
  index: number;
  language: string | null;
  codec: string | null;
  displayTitle: string | null;
}

export interface SubtitleTrackInfo {
  index: number;
  language: string | null;
  codec: string | null;
  isForced: boolean;
  isDefault: boolean;
  displayTitle: string | null;
  deliveryUrl: string;
}

export interface FontAttachmentInfo {
  index: number;
  fileName: string | null;
  mimeType: string | null;
  deliveryUrl: string;
}

export function subtitleFormat(codec: string | null): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c === "subrip") return "srt";
  if (c === "webvtt") return "vtt";
  return c;
}

function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function buildSubtitleUrl(
  baseUrl: string,
  itemId: string,
  mediaSourceId: string,
  index: number,
  codec: string | null,
  token: string,
): string | null {
  const format = subtitleFormat(codec);
  if (!format) return null;
  return `${trimTrailingSlash(baseUrl)}/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/0/Stream.${format}?ApiKey=${token}`;
}

export function buildAttachmentUrl(
  baseUrl: string,
  itemId: string,
  mediaSourceId: string,
  index: number,
  token: string,
): string {
  return `${trimTrailingSlash(baseUrl)}/Videos/${itemId}/${mediaSourceId}/Attachments/${index}?ApiKey=${token}`;
}

export interface PlaybackStartResult {
  url: string;
  startPositionTicks: number;
  itemId: string;
  mediaSourceId: string | null;
  playSessionId: string | null;
  playMethod: "Transcode" | "DirectStream" | "DirectPlay";
  videoCodec: string | null;
  nextEpisodeId: number | null;
  nextEpisodeNumber: number | null;
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  animeTitle: string | null;
  audioTracks: AudioTrackInfo[];
  selectedAudioIndex: number | null;
  subtitleTracks: SubtitleTrackInfo[];
  fontAttachments: FontAttachmentInfo[];
  selectedSubtitleIndex: number | null;
  skipSegments: JellyfinSkipSegments;
}

export class PlaybackService {
  constructor(
    private readonly db: Db,
    private readonly jellyfin: JellyfinClient,
    private readonly config: {
      jellyfinUrl: string;
      serviceUsername: string;
      servicePassword: string;
    },
  ) {}

  async startPlayback(
    episodeId: number,
    options: {
      resume?: boolean;
      userId?: number;
      audioStreamIndex?: number;
    } = {},
  ): Promise<PlaybackStartResult> {
    const episode = this.db
      .select()
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .get();
    if (!episode || !episode.jellyfinItemId || !episode.available) {
      throw new EpisodeNotAvailableError();
    }
    const season = this.db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
    const anime = season
      ? this.db.select().from(animes).where(eq(animes.id, season.animeId)).get()
      : null;

    const auth = await this.jellyfin.authenticateUserByName(
      this.config.serviceUsername,
      this.config.servicePassword,
    );

    const resume = options.resume === true && !episode.watched && episode.progressSeconds > 0;
    const startPositionTicks = resume ? episode.progressSeconds * 10_000_000 : 0;

    const media = await this.jellyfin.getMediaSource(episode.jellyfinItemId, auth.accessToken);
    const streams = media.streams;
    const videoCodec = streams.find((s) => s.type === "Video")?.codec ?? null;
    const preferenceService = new TrackPreferenceService(this.db);
    const prefs = preferenceService.getPreferenceForEpisode(options.userId, episodeId);
    const match = preferenceService.matchStreams(streams, prefs);

    const audioStreamIndex = options.audioStreamIndex ?? match.audioStreamIndex ?? null;

    const audioTracks = streams
      .filter((s) => s.type === "Audio")
      .map((s) => ({
        index: s.index,
        language: s.language,
        codec: s.codec,
        displayTitle: s.displayTitle,
      }) satisfies AudioTrackInfo);

    const mediaSourceId = media.mediaSourceId ?? episode.jellyfinItemId;
    const subtitleTracks = streams
      .filter((s) => s.type === "Subtitle" && isTextSubtitleCodec(s.codec))
      .flatMap((s) => {
        const deliveryUrl = buildSubtitleUrl(
          this.config.jellyfinUrl,
          episode.jellyfinItemId!,
          mediaSourceId,
          s.index,
          s.codec,
          auth.accessToken,
        );
        if (!deliveryUrl) return [];
        return [
          {
            index: s.index,
            language: s.language,
            codec: s.codec,
            isForced: s.isForced,
            isDefault: s.isDefault,
            displayTitle: s.displayTitle,
            deliveryUrl,
          } satisfies SubtitleTrackInfo,
        ];
      });

    const fontAttachments = media.attachments.map(
      (a) =>
        ({
          index: a.index,
          fileName: a.fileName,
          mimeType: a.mimeType,
          deliveryUrl: buildAttachmentUrl(
            this.config.jellyfinUrl,
            episode.jellyfinItemId!,
            mediaSourceId,
            a.index,
            auth.accessToken,
          ),
        }) satisfies FontAttachmentInfo,
    );

    const burnInSubtitleIndex = subtitleTracks.length === 0 ? match.burnInSubtitleStreamIndex : undefined;

    const [playbackInfo, skipSegments] = await Promise.all([
      this.jellyfin.getPlaybackInfo(
        episode.jellyfinItemId,
        auth.userId,
        auth.accessToken,
        startPositionTicks,
        audioStreamIndex ?? undefined,
        burnInSubtitleIndex,
      ),
      // Intro Skipper segments are advisory only — a missing plugin or an
      // unanalyzed episode must never break playback.
      this.jellyfin
        .getIntroSkipperSegments(episode.jellyfinItemId, auth.accessToken)
        .catch(() => ({ intro: null, credits: null }) satisfies JellyfinSkipSegments),
    ]);

    const nextEpisode = this.getNextAvailableEpisode(episodeId);

    return {
      url: playbackInfo.url,
      startPositionTicks,
      itemId: episode.jellyfinItemId,
      mediaSourceId: playbackInfo.mediaSourceId,
      playSessionId: playbackInfo.playSessionId,
      playMethod: playbackInfo.playMethod,
      videoCodec,
      nextEpisodeId: nextEpisode?.id ?? null,
      nextEpisodeNumber: nextEpisode?.episodeNumber ?? null,
      episodeId: episode.id,
      seasonNumber: season?.number ?? 1,
      episodeNumber: episode.episodeNumber,
      animeTitle: anime?.titleRomaji ?? anime?.titleEnglish ?? null,
      audioTracks,
      selectedAudioIndex: audioStreamIndex,
      subtitleTracks,
      fontAttachments,
      selectedSubtitleIndex: match.subtitleStreamIndex ?? null,
      skipSegments,
    };
  }

  getNextAvailableEpisode(episodeId: number): { id: number; seasonNumber: number; episodeNumber: number } | null {
    const episode = this.db
      .select()
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .get();
    if (!episode) return null;

    const season = this.db
      .select()
      .from(seasons)
      .where(eq(seasons.id, episode.seasonId))
      .get();
    if (!season) return null;

    const next = this.db
      .select({ id: episodes.id, seasonNumber: seasons.number, episodeNumber: episodes.episodeNumber })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(
        and(
          eq(seasons.animeId, season.animeId),
          eq(episodes.available, true),
          or(
            gt(seasons.number, season.number),
            and(eq(seasons.number, season.number), gt(episodes.episodeNumber, episode.episodeNumber)),
          ),
        ),
      )
      .orderBy(seasons.number, episodes.episodeNumber)
      .get();

    return next
      ? { id: next.id, seasonNumber: next.seasonNumber, episodeNumber: next.episodeNumber }
      : null;
  }
}
