import { and, eq, gt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons } from "../db/schema";
import type { JellyfinClient } from "../integrations/types";
import { isTextSubtitleCodec } from "../player/subtitles";
import { TrackPreferenceService } from "./track-preference-service";

export class EpisodeNotAvailableError extends Error {
  constructor() {
    super("Episode is not available for playback");
  }
}

export interface SubtitleTrackInfo {
  index: number;
  language: string | null;
  isForced: boolean;
  codec: string | null;
  displayTitle: string | null;
  isText: boolean;
  url: string | null;
}

export interface AudioTrackInfo {
  index: number;
  language: string | null;
  codec: string | null;
  displayTitle: string | null;
}

export interface PlaybackStartResult {
  url: string;
  startPositionTicks: number;
  itemId: string;
  mediaSourceId: string | null;
  playSessionId: string | null;
  playMethod: "Transcode" | "DirectStream" | "DirectPlay";
  nextEpisodeId: number | null;
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  animeTitle: string | null;
  subtitleTracks: SubtitleTrackInfo[];
  audioTracks: AudioTrackInfo[];
  fontUrls: string[];
  selectedAudioIndex: number | null;
  selectedSubtitleIndex: number | null;
}

const FONT_CODECS = new Set(["ttf", "otf", "woff", "woff2"]);

function subtitleExtension(codec: string | null): string {
  switch (codec?.toLowerCase()) {
    case "ass":
    case "ssa":
      return "ass";
    case "srt":
    case "subrip":
      return "srt";
    default:
      return codec ?? "ass";
  }
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
      subtitleStreamIndex?: number;
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
    const preferenceService = new TrackPreferenceService(this.db);
    const prefs = preferenceService.getPreferenceForEpisode(options.userId, episodeId);
    const match = preferenceService.matchStreams(streams, prefs);

    const audioStreamIndex = options.audioStreamIndex ?? match.audioStreamIndex ?? null;
    const subtitleStreamIndex = options.subtitleStreamIndex ?? match.subtitleStreamIndex ?? null;

    const itemId = episode.jellyfinItemId;
    const mediaSourceId = media.mediaSourceId;

    const subtitleTracks = streams
      .filter((s) => s.type === "Subtitle")
      .map((s) => {
        const isText = isTextSubtitleCodec(s.codec);
        return {
          index: s.index,
          language: s.language,
          isForced: s.isForced,
          codec: s.codec,
          displayTitle: s.displayTitle,
          isText,
          url:
            isText && mediaSourceId != null
              ? this.buildSubtitleUrl(itemId, mediaSourceId, s.index, s.codec, auth.accessToken)
              : null,
        } satisfies SubtitleTrackInfo;
      });

    const audioTracks = streams
      .filter((s) => s.type === "Audio")
      .map((s) => ({
        index: s.index,
        language: s.language,
        codec: s.codec,
        displayTitle: s.displayTitle,
      }) satisfies AudioTrackInfo);

    const fontUrls = media.attachments
      .filter((a) => a.codec && FONT_CODECS.has(a.codec.toLowerCase()))
      .map((a) =>
        mediaSourceId != null
          ? this.buildAttachmentUrl(itemId, mediaSourceId, a.index, auth.accessToken)
          : null,
      )
      .filter((url): url is string => url != null);

    const selectedSubtitle = subtitleStreamIndex != null
      ? subtitleTracks.find((t) => t.index === subtitleStreamIndex)
      : null;
    const burnInSubtitles = selectedSubtitle != null && !selectedSubtitle.isText;

    const playbackInfo = await this.jellyfin.getPlaybackInfo(
      episode.jellyfinItemId,
      auth.userId,
      auth.accessToken,
      startPositionTicks,
      audioStreamIndex ?? undefined,
      burnInSubtitles ? subtitleStreamIndex ?? undefined : undefined,
      burnInSubtitles,
    );

    return {
      url: playbackInfo.url,
      startPositionTicks,
      itemId: episode.jellyfinItemId,
      mediaSourceId: playbackInfo.mediaSourceId,
      playSessionId: playbackInfo.playSessionId,
      playMethod: playbackInfo.playMethod,
      nextEpisodeId: this.getNextAvailableEpisode(episodeId),
      episodeId: episode.id,
      seasonNumber: season?.number ?? 1,
      episodeNumber: episode.episodeNumber,
      animeTitle: anime?.titleRomaji ?? anime?.titleEnglish ?? null,
      subtitleTracks,
      audioTracks,
      fontUrls,
      selectedAudioIndex: audioStreamIndex,
      selectedSubtitleIndex: subtitleStreamIndex,
    };
  }

  private buildSubtitleUrl(
    itemId: string,
    mediaSourceId: string,
    streamIndex: number,
    codec: string | null,
    token: string,
  ): string {
    const ext = subtitleExtension(codec);
    return `${this.config.jellyfinUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/0/Stream.${ext}?ApiKey=${token}`;
  }

  private buildAttachmentUrl(
    itemId: string,
    mediaSourceId: string,
    attachmentIndex: number,
    token: string,
  ): string {
    return `${this.config.jellyfinUrl}/Videos/${itemId}/${mediaSourceId}/Attachments/${attachmentIndex}?ApiKey=${token}`;
  }

  getNextAvailableEpisode(episodeId: number): number | null {
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

    return next?.id ?? null;
  }
}
