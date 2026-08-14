import { and, eq, gt, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons } from "../db/schema";
import type { JellyfinClient } from "../integrations/types";
import { TrackPreferenceService } from "./track-preference-service";

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
  audioTracks: AudioTrackInfo[];
  selectedAudioIndex: number | null;
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

    const playbackInfo = await this.jellyfin.getPlaybackInfo(
      episode.jellyfinItemId,
      auth.userId,
      auth.accessToken,
      startPositionTicks,
      audioStreamIndex ?? undefined,
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
      audioTracks,
      selectedAudioIndex: audioStreamIndex,
    };
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
