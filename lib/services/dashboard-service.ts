import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons } from "../db/schema";
import type { AniListClient } from "../integrations/types";
import { formatEpisodeLabel } from "./episode-service";

export interface ContinueWatchingItem {
  episodeId: number;
  animeId: number;
  animeTitle: string;
  coverImageUrl: string | null;
  backdropUrl: string | null;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle: string | null;
  label: string;
  progressSeconds: number;
  durationSeconds: number | null;
}

export interface WatchingItem {
  id: number;
  titleRomaji: string;
  titleEnglish: string | null;
  coverImageUrl: string | null;
  format: string | null;
  seasonYear: number | null;
  episodeCount: number | null;
}

export interface UpcomingItem {
  animeId: number;
  titleRomaji: string;
  titleEnglish: string | null;
  coverImageUrl: string | null;
  nextEpisodeAt: number;
  episode: number | null;
}

interface ScheduleEntry {
  airingAt: number | null;
  episode: number | null;
}

const SCHEDULE_CACHE_TTL_MS = 60 * 60 * 1000;

export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly options: {
      jellyfinUrl?: string;
      scheduleCacheTtlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private scheduleCache:
    | { expiresAt: number; byAnilistId: Map<number, ScheduleEntry> }
    | null = null;

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  getContinueWatching(): ContinueWatchingItem[] {
    const base = {
      episodeId: episodes.id,
      animeId: animes.id,
      animeTitle: animes.titleEnglish ?? animes.titleRomaji,
      coverImageUrl: animes.coverImageUrl,
      jellyfinId: animes.jellyfinId,
      lastWatchedAt: animes.lastWatchedAt,
      seasonNumber: seasons.number,
      episodeNumber: episodes.episodeNumber,
      episodeTitle: episodes.title,
      progressSeconds: episodes.progressSeconds,
      durationSeconds: episodes.durationSeconds,
    } as const;

    // In-progress episodes (resume candidates).
    const resumeRows = this.db
      .select(base)
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .innerJoin(animes, eq(animes.id, seasons.animeId))
      .where(and(eq(episodes.watched, false), gt(episodes.progressSeconds, 0)))
      .orderBy(desc(animes.lastWatchedAt), animes.titleRomaji, seasons.number, episodes.episodeNumber)
      .all();

    // "Next up" candidates: for anime with a watch history (lastWatchedAt set),
    // the earliest unwatched available episode — so after finishing an episode
    // the hero still offers the next one instead of disappearing.
    const nextUpRows = this.db
      .select(base)
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .innerJoin(animes, eq(animes.id, seasons.animeId))
      .where(and(eq(episodes.watched, false), eq(episodes.available, true), isNotNull(animes.lastWatchedAt)))
      .orderBy(desc(animes.lastWatchedAt), animes.titleRomaji, seasons.number, episodes.episodeNumber)
      .all();

    const seenAnime = new Set<number>();
    const nextUp = nextUpRows.filter((row) => {
      if (seenAnime.has(row.animeId)) return false;
      seenAnime.add(row.animeId);
      return true;
    });

    const resumeAnime = new Set(resumeRows.map((r) => r.animeId));
    const merged = [...resumeRows, ...nextUp.filter((r) => !resumeAnime.has(r.animeId))].sort((a, b) => {
      const at = (x: number | null) => x ?? 0;
      return at(b.lastWatchedAt) - at(a.lastWatchedAt);
    });

    return merged.map((row) => ({
      episodeId: row.episodeId,
      animeId: row.animeId,
      animeTitle: row.animeTitle ?? "Unknown",
      coverImageUrl: row.coverImageUrl,
      backdropUrl: row.jellyfinId && this.options.jellyfinUrl
        ? `${this.options.jellyfinUrl}/Items/${row.jellyfinId}/Images/Backdrop?maxWidth=1920&quality=90`
        : null,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      episodeTitle: row.episodeTitle,
      label: formatEpisodeLabel(row.seasonNumber, row.episodeNumber),
      progressSeconds: row.progressSeconds,
      durationSeconds: row.durationSeconds,
    }));
  }

  getWatching(limit = 12): WatchingItem[] {
    return this.db
      .select({
        id: animes.id,
        titleRomaji: animes.titleRomaji,
        titleEnglish: animes.titleEnglish,
        coverImageUrl: animes.coverImageUrl,
        format: animes.format,
        seasonYear: animes.seasonYear,
        episodeCount: animes.episodeCount,
      })
      .from(animes)
      .where(eq(animes.status, "watching"))
      .orderBy(
        desc(animes.lastWatchedAt),
        animes.titleRomaji,
      )
      .limit(limit)
      .all();
  }

  async getUpcoming(limit = 12, now: number = Date.now(), anilist?: AniListClient): Promise<UpcomingItem[]> {
    let scheduleById = new Map<number, ScheduleEntry>();
    if (anilist) {
      const candidates = this.db
        .select({ id: animes.id, anilistId: animes.anilistId })
        .from(animes)
        .where(isNotNull(animes.nextEpisodeAt))
        .all();
      if (candidates.length > 0) {
        const cached =
          this.scheduleCache && this.scheduleCache.expiresAt > this.now()
            ? this.scheduleCache
            : null;
        if (cached) {
          scheduleById = cached.byAnilistId;
        } else {
          try {
            const entries = await anilist.getAiringSchedule(candidates.map((c) => c.anilistId));
            scheduleById = new Map(entries.map((e) => [e.anilistId, e]));
            this.scheduleCache = {
              expiresAt: this.now() + (this.options.scheduleCacheTtlMs ?? SCHEDULE_CACHE_TTL_MS),
              byAnilistId: scheduleById,
            };
            for (const entry of entries) {
              this.db
                .update(animes)
                .set({ nextEpisodeAt: entry.airingAt })
                .where(eq(animes.anilistId, entry.anilistId))
                .run();
            }
          } catch {
            // Fall back to stored values.
          }
        }
      }
    }

    return this.db
      .select({
        animeId: animes.id,
        anilistId: animes.anilistId,
        titleRomaji: animes.titleRomaji,
        titleEnglish: animes.titleEnglish,
        coverImageUrl: animes.coverImageUrl,
        nextEpisodeAt: animes.nextEpisodeAt,
      })
      .from(animes)
      .where(and(isNotNull(animes.nextEpisodeAt), gt(animes.nextEpisodeAt, now), eq(animes.status, "watching")))
      .orderBy(animes.nextEpisodeAt)
      .limit(limit)
      .all()
      .map((row) => ({
        animeId: row.animeId,
        titleRomaji: row.titleRomaji,
        titleEnglish: row.titleEnglish,
        coverImageUrl: row.coverImageUrl,
        nextEpisodeAt: row.nextEpisodeAt as number,
        episode: scheduleById.get(row.anilistId)?.episode ?? null,
      }));
  }
}

