export interface AniListItem {
  id: number;
  malId: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  synopsis: string | null;
  coverImageUrl: string | null;
  bannerImageUrl: string | null;
  genres: string[];
  format: string | null;
  seasonYear: number | null;
  episodeCount: number | null;
  nextEpisodeAt: number | null;
}

export interface AniListClient {
  search(query: string): Promise<AniListItem[]>;
  getById(id: number): Promise<AniListItem | null>;
  getByMalId(malId: number): Promise<AniListItem | null>;
  getByMalIds(ids: number[]): Promise<AniListItem[]>;
  getAiringSchedule(ids: number[]): Promise<{ anilistId: number; airingAt: number | null; episode: number | null }[]>;
}

export interface MalListEntry {
  animeId: number;
  title: string | null;
  status: "watching" | "completed" | "on_hold" | "dropped" | "plan_to_watch";
  watchedEpisodes: number;
  score: number | null;
}

export interface MalToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface MalClient {
  createAuthUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<MalToken>;
  getMyList(accessToken: string): Promise<MalListEntry[]>;
  getListEntry(accessToken: string, animeId: number): Promise<MalListEntry | null>;
  updateStatus(accessToken: string, animeId: number, status: MalListEntry["status"], watchedEpisodes: number, score?: number | null): Promise<void>;
  refreshAccessToken(refreshToken: string): Promise<MalToken>;
}

export interface SonarrCandidate {
  tvdbId: number;
  title: string;
  year: number | null;
  status: string | null;
  seriesType: string;
  seasons: { seasonNumber: number }[];
}

export interface SonarrEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number | null;
  title: string | null;
}

export interface SonarrSeries {
  id: number;
  tvdbId: number | null;
  title: string;
  year: number | null;
  status: string | null;
  monitored: boolean;
  episodeFileCount: number;
  totalEpisodeCount: number;
  monitoredEpisodesTotal: number;
  sizeOnDisk: number;
  addedAt: number | null;
}

export interface SonarrDiskSpace {
  path: string;
  freeSpace: number;
  totalSpace: number;
}

export type MonitorOption =
  | { type: "all" }
  | { type: "firstSeason" }
  | { type: "lastSeason" }
  | { type: "future" }
  | { type: "missing" }
  | { type: "recent" }
  | { type: "specificSeason"; season: number };

export interface SonarrClient {
  lookup(term: string): Promise<SonarrCandidate[]>;
  addSeries(candidate: SonarrCandidate, rootFolderPath: string, qualityProfileId: number, monitor?: MonitorOption): Promise<{ id: number }>;
  getEpisodes(seriesId: number): Promise<SonarrEpisode[]>;
  getQueue(): Promise<unknown[]>;
  getEpisodeFiles(seriesId: number): Promise<unknown[]>;
  getQualityProfiles(): Promise<unknown[]>;
  getQualityDefinitions(): Promise<unknown[]>;
  createQualityProfile(profile: unknown): Promise<{ id: number }>;
  updateQualityProfile(id: number, profile: unknown): Promise<unknown>;
  getCustomFormats(): Promise<unknown[]>;
  createCustomFormat(format: unknown): Promise<{ id: number }>;
  updateCustomFormat(id: number, format: unknown): Promise<unknown>;
  getManualImport(folder: string): Promise<unknown[]>;
  triggerImport(files: unknown[]): Promise<{ id: number }>;
  getSeries(): Promise<SonarrSeries[]>;
  getDiskSpace(): Promise<SonarrDiskSpace[]>;
  deleteSeries(id: number, deleteFiles: boolean): Promise<void>;
}

export interface JellyfinSeriesItem {
  id: string;
  tvdbId: number | null;
  title: string | null;
}

export interface JellyfinEpisodeItem {
  id: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  name: string | null;
  thumbnailUrl: string | null;
  userData: { played: boolean; positionTicks: number } | null;
}

export interface JellyfinSession {
  id: string;
  client: string;
  deviceName: string | null;
  userId: string | null;
}

export interface JellyfinAuth {
  accessToken: string;
  userId: string;
}

export interface JellyfinMediaStream {
  index: number;
  type: "Audio" | "Subtitle" | "Video";
  codec: string | null;
  language: string | null;
  isForced: boolean;
  isDefault: boolean;
  displayTitle: string | null;
}

export interface JellyfinMediaAttachment {
  index: number;
  codec: string | null;
  fileName: string | null;
  mimeType: string | null;
}

export interface JellyfinMediaSource {
  mediaSourceId: string | null;
  streams: JellyfinMediaStream[];
  attachments: JellyfinMediaAttachment[];
}

export interface JellyfinPlaybackInfo {
  url: string;
  playMethod: "Transcode" | "DirectStream" | "DirectPlay";
  mediaSourceId: string | null;
  playSessionId: string | null;
}

export interface JellyfinSkipSegment {
  start: number;
  end: number;
}

export interface JellyfinSkipSegments {
  intro: JellyfinSkipSegment | null;
  credits: JellyfinSkipSegment | null;
}

export interface JellyfinClient {
  getSeries(): Promise<JellyfinSeriesItem[]>;
  getEpisodes(seriesId: string): Promise<JellyfinEpisodeItem[]>;
  getSessions(): Promise<JellyfinSession[]>;
  getMediaStreams(itemId: string, accessToken: string): Promise<JellyfinMediaStream[]>;
  getMediaSource(itemId: string, accessToken: string): Promise<JellyfinMediaSource>;
  authenticateUserByName(username: string, password: string): Promise<JellyfinAuth>;
  getPlaybackInfo(itemId: string, userId: string, accessToken: string, startPositionTicks: number, audioStreamIndex?: number, subtitleStreamIndex?: number): Promise<JellyfinPlaybackInfo>;
  getIntroSkipperSegments(itemId: string, accessToken: string): Promise<JellyfinSkipSegments>;
  getIntroAnalysisTaskId(): Promise<string | null>;
  getIntroScanStatus(): Promise<boolean>;
  runScheduledTask(taskId: string): Promise<boolean>;
  requestPlayback(sessionId: string, itemId: string, startPositionTicks?: number): Promise<void>;
  deleteItem(id: string): Promise<void>;
  refreshLibrary(): Promise<void>;
}

export interface JellyfinWebhookPayload {
  NotificationType: string;
  ItemId?: string;
  ItemType?: string;
  SeriesName?: string;
  SeasonNumber?: number;
  EpisodeNumber?: number;
  UserId?: string;
  RunTimeTicks?: number;
  PlaybackPositionTicks?: number;
  PlayedToCompletion?: boolean;
}
