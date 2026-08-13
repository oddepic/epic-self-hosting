import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons, type Anime } from "../db/schema";

export interface SeasonSummary {
  number: number;
  watchedCount: number;
  totalCount: number;
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
  anime: Anime;
  seasons: SeasonSummary[];
  episodes: EpisodeRow[];
  resume: EpisodeRef | null;
  start: EpisodeRef | null;
  fullyDownloaded: boolean;
}

export class AnimeDetailService {
  constructor(private readonly db: Db) {}

  getDetail(animeId: number, seasonNumber?: number): AnimeDetail | null {
    const anime = this.db.select().from(animes).where(eq(animes.id, animeId)).get();
    if (!anime) return null;

    const seasonRows = this.db
      .select()
      .from(seasons)
      .where(eq(seasons.animeId, animeId))
      .orderBy(seasons.number)
      .all();

    const seasonsSummary: SeasonSummary[] = seasonRows.map((season) => ({
      number: season.number,
      watchedCount: this.countEpisodes(season.id, true),
      totalCount: this.countEpisodes(season.id, false),
    }));

    const resume = this.findFirstResumable(animeId);
    const start = this.findFirstAvailable(animeId);

    const selectedNumber = seasonNumber ?? resume?.seasonNumber ?? seasonsSummary[0]?.number ?? null;

    const episodeRows: EpisodeRow[] = selectedNumber == null
      ? []
      : this.db
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
          .innerJoin(
            seasons,
            and(
              eq(seasons.id, episodes.seasonId),
              eq(seasons.animeId, animeId),
              eq(seasons.number, selectedNumber),
            ),
          )
          .orderBy(episodes.episodeNumber)
          .all();

    return {
      anime,
      seasons: seasonsSummary,
      episodes: episodeRows,
      resume,
      start,
      fullyDownloaded: this.isFullyDownloaded(animeId),
    };
  }

  private isFullyDownloaded(animeId: number): boolean {
    const counts = this.db
      .select({
        total: sql<number>`count(*)`,
        available: sql<number>`sum(case when ${episodes.available} then 1 else 0 end)`,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(eq(seasons.animeId, animeId))
      .get();
    const total = counts?.total ?? 0;
    return total > 0 && (counts?.available ?? 0) === total;
  }

  private countEpisodes(seasonId: number, watchedOnly: boolean): number {
    const condition = watchedOnly
      ? and(eq(episodes.seasonId, seasonId), eq(episodes.watched, true))
      : eq(episodes.seasonId, seasonId);
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(episodes)
        .where(condition)
        .get()?.count ?? 0
    );
  }

  private findFirstResumable(animeId: number): EpisodeRef | null {
    const row = this.db
      .select({
        episodeId: episodes.id,
        seasonNumber: seasons.number,
        episodeNumber: episodes.episodeNumber,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(
        and(
          eq(seasons.animeId, animeId),
          eq(episodes.watched, false),
          gt(episodes.progressSeconds, 0),
        ),
      )
      .orderBy(seasons.number, episodes.episodeNumber)
      .get();
    return row ?? null;
  }

  private findFirstAvailable(animeId: number): EpisodeRef | null {
    const row = this.db
      .select({
        episodeId: episodes.id,
        seasonNumber: seasons.number,
        episodeNumber: episodes.episodeNumber,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .where(and(eq(seasons.animeId, animeId), eq(episodes.available, true)))
      .orderBy(seasons.number, episodes.episodeNumber)
      .get();
    return row ?? null;
  }
}
