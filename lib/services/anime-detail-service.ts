import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons, type Anime } from "../db/schema";
import { getFranchise } from "./franchise-service";

export interface SeasonSummary {
  number: number;
  watchedCount: number;
  totalCount: number;
  availableCount: number;
  /** Canonical member supplying this season's episode rows. */
  ownerAnimeId: number;
  isSpecials: boolean;
  year: number | null;
}

export interface FranchiseMemberInfo {
  id: number;
  title: string;
  titleRomaji: string;
  titleEnglish: string | null;
  status: Anime["status"];
  score: number | null;
  watchedEpisodes: number;
  episodeCount: number | null;
  format: string | null;
  seasonYear: number | null;
  coverImageUrl: string | null;
  bannerImageUrl: string | null;
  sonarrId: number | null;
  entrySeasonNumber: number | null;
}

export interface EpisodeRow {
  id: number;
  episodeNumber: number;
  absoluteNumber: number | null;
  title: string | null;
  thumbnailUrl: string | null;
  available: boolean;
  watched: boolean;
  progressSeconds: number;
  durationSeconds: number | null;
}

export interface EpisodeRef {
  episodeId: number;
  seasonNumber: number;
  episodeNumber: number;
}

export interface AnimeDetail {
  /** The clicked entry — header controls bind to it unless another member owns the selected season. */
  anime: Anime;
  members: FranchiseMemberInfo[];
  seasons: SeasonSummary[];
  episodes: EpisodeRow[];
  selectedSeasonNumber: number | null;
  selectedEntryId: number;
  resume: EpisodeRef | null;
  start: EpisodeRef | null;
  fullyDownloaded: boolean;
}

export class AnimeDetailService {
  constructor(private readonly db: Db) {}

  getDetail(animeId: number, seasonNumber?: number): AnimeDetail | null {
    const anime = this.db.select().from(animes).where(eq(animes.id, animeId)).get();
    if (!anime) return null;

    const franchise = getFranchise(this.db, animeId);
    const members: FranchiseMemberInfo[] = franchise.members.map((member) => ({
      id: member.anime.id,
      title: member.anime.titleEnglish ?? member.anime.titleRomaji,
      titleRomaji: member.anime.titleRomaji,
      titleEnglish: member.anime.titleEnglish,
      status: member.anime.status,
      score: member.anime.score,
      watchedEpisodes: member.anime.watchedEpisodes,
      episodeCount: member.anime.episodeCount,
      format: member.anime.format,
      seasonYear: member.anime.seasonYear,
      coverImageUrl: member.anime.coverImageUrl,
      bannerImageUrl: member.anime.bannerImageUrl,
      sonarrId: member.anime.sonarrId,
      entrySeasonNumber: member.entrySeasonNumber,
    }));

    // Canonical episode rows per season come from the owning member only —
    // other franchise members duplicate the same physical seasons.
    const ownerSeasonIds = franchise.seasons.map((s) => s.ownerSeasonId);
    const ownerSeasonByNumber = new Map(franchise.seasons.map((s) => [s.number, s]));

    const resume = this.findFirstResumable(ownerSeasonIds);
    const start = this.findFirstAvailable(ownerSeasonIds);

    const selected =
      this.pickSelectedSeason(seasonNumber, franchise.seasons, resume?.seasonNumber ?? null, members, anime) ??
      null;

    const selectedEntryId =
      members.find((m) => m.entrySeasonNumber === selected)?.id ?? anime.id;

    const selectedSummary = selected != null ? ownerSeasonByNumber.get(selected) : undefined;
    const episodeRows: EpisodeRow[] = selectedSummary
      ? this.db
          .select({
            id: episodes.id,
            episodeNumber: episodes.episodeNumber,
            absoluteNumber: episodes.absoluteNumber,
            title: episodes.title,
            thumbnailUrl: episodes.thumbnailUrl,
            available: episodes.available,
            watched: episodes.watched,
            progressSeconds: episodes.progressSeconds,
            durationSeconds: episodes.durationSeconds,
          })
          .from(episodes)
          .where(eq(episodes.seasonId, selectedSummary.ownerSeasonId))
          .orderBy(episodes.episodeNumber)
          .all()
      : [];

    return {
      anime,
      members,
      seasons: [...franchise.seasons].sort((a, b) => a.number - b.number),
      episodes: episodeRows,
      selectedSeasonNumber: selected,
      selectedEntryId,
      resume,
      start,
      fullyDownloaded: this.isFullyDownloaded(ownerSeasonIds),
    };
  }

  // Default-season order: explicit param → the clicked entry's own mapped
  // season → where playback would resume → first season with content.
  private pickSelectedSeason(
    requested: number | undefined,
    seasons: Array<{ number: number; availableCount: number; isSpecials: boolean }>,
    resumeSeasonNumber: number | null,
    members: FranchiseMemberInfo[],
    clicked: Anime,
  ): number | null {
    if (requested != null && seasons.some((s) => s.number === requested)) return requested;

    const mapped = members.find((m) => m.id === clicked.id)?.entrySeasonNumber ?? null;
    if (mapped != null && seasons.some((s) => s.number === mapped)) return mapped;

    if (resumeSeasonNumber != null && seasons.some((s) => s.number === resumeSeasonNumber)) {
      return resumeSeasonNumber;
    }

    const nonSpecials = seasons.filter((s) => !s.isSpecials);
    const pool = nonSpecials.length > 0 ? nonSpecials : seasons;
    const withContent = pool.find((s) => s.availableCount > 0);
    if (withContent) return withContent.number;

    return pool[0]?.number ?? seasons[0]?.number ?? null;
  }

  private isFullyDownloaded(seasonIds: number[]): boolean {
    if (seasonIds.length === 0) return false;
    const counts = this.db
      .select({
        total: sql<number>`count(*)`,
        available: sql<number>`sum(case when ${episodes.available} then 1 else 0 end)`,
      })
      .from(episodes)
      .where(inArray(episodes.seasonId, seasonIds))
      .get();
    const total = counts?.total ?? 0;
    return total > 0 && (counts?.available ?? 0) === total;
  }

  private findFirstResumable(seasonIds: number[]): EpisodeRef | null {
    if (seasonIds.length === 0) return null;
    const row = this.db
      .select({
        episodeId: episodes.id,
        seasonNumber: seasons.number,
        episodeNumber: episodes.episodeNumber,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(and(inArray(episodes.seasonId, seasonIds), eq(episodes.watched, false), gt(episodes.progressSeconds, 0)))
      .orderBy(seasons.number, episodes.episodeNumber)
      .get();
    return row ?? null;
  }

  private findFirstAvailable(seasonIds: number[]): EpisodeRef | null {
    if (seasonIds.length === 0) return null;
    const row = this.db
      .select({
        episodeId: episodes.id,
        seasonNumber: seasons.number,
        episodeNumber: episodes.episodeNumber,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(and(inArray(episodes.seasonId, seasonIds), eq(episodes.available, true)))
      .orderBy(seasons.number, episodes.episodeNumber)
      .get();
    return row ?? null;
  }
}
