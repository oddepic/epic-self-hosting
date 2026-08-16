import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons, type Anime } from "../db/schema";
import type { JellyfinClient, JellyfinSeriesItem, SonarrClient, SonarrSeries } from "../integrations/types";

export interface SyncResult {
  seriesMatched: number;
  seriesLinked: number;
  episodesAvailable: number;
  progressUpdated: number;
  jellyfinRebuilt?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function matchSeries(anime: Anime, seriesList: JellyfinSeriesItem[]): JellyfinSeriesItem | null {
  if (anime.tvdbId != null) {
    const byTvdb = seriesList.find((s) => s.tvdbId === anime.tvdbId);
    if (byTvdb) return byTvdb;
  }

  const variants = [anime.titleRomaji, anime.titleEnglish, anime.titleNative]
    .filter((t): t is string => Boolean(t))
    .map(normalizeTitle);
  return (
    seriesList.find((s) => s.title && variants.includes(normalizeTitle(s.title))) ?? null
  );
}

function matchSonarrSeries(anime: Anime, seriesList: SonarrSeries[]): SonarrSeries | null {
  if (anime.tvdbId != null) {
    const byTvdb = seriesList.find((s) => s.tvdbId === anime.tvdbId);
    if (byTvdb) return byTvdb;
  }

  const variants = [anime.titleRomaji, anime.titleEnglish, anime.titleNative]
    .filter((t): t is string => Boolean(t))
    .map(normalizeTitle);
  return (
    seriesList.find((s) => variants.includes(normalizeTitle(s.title))) ?? null
  );
}

// Jellyfin fills missing episode metadata with fallback names — the series
// title, "Episode N" / "Episode #S.E", or a bare number. Those are noise, not
// titles: treat them as "no title" so the UI falls back to its own "EP N"
// label instead of showing the anime's name or a meaningless number.
function fuzzyTitle(title: string): string {
  return normalizeTitle(title).replace(/[^a-z0-9]+/g, "");
}

export function sanitizeEpisodeTitle(
  name: string | null | undefined,
  seriesTitles: (string | null | undefined)[],
): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const normalized = normalizeTitle(trimmed);
  if (seriesTitles.some((t) => t != null && normalizeTitle(t) === normalized)) {
    return null;
  }
  // Fallback names can differ from the series title only in punctuation
  // ("Re ZERO Starting..." vs "Re:ZERO -Starting...-") — compare fuzzy too.
  const fuzzy = fuzzyTitle(trimmed);
  if (fuzzy !== "" && seriesTitles.some((t) => t != null && fuzzyTitle(t) === fuzzy)) {
    return null;
  }
  if (/^episode\s+#?\d+(\.\d+)?$/i.test(trimmed)) return null;
  if (/^ep\s*\d+$/i.test(trimmed)) return null;
  if (/^\d+$/.test(trimmed)) return null;
  return trimmed;
}

export class AvailabilityService {
  constructor(
    private readonly db: Db,
    private readonly jellyfin: JellyfinClient,
    private readonly sonarr?: SonarrClient,
    private readonly options: {
      rebuildDelayMs?: number;
    } = {},
  ) {}

  async sync(): Promise<SyncResult> {
    const result: SyncResult = { seriesMatched: 0, seriesLinked: 0, episodesAvailable: 0, progressUpdated: 0 };

    const animeRows = this.db.select().from(animes).all();
    const hasSonarrLinked = animeRows.some((anime) => anime.sonarrId != null);

    let seriesList = await this.jellyfin.getSeries();

    // Self-heal: if we expect content in Jellyfin (anime linked to Sonarr) but the
    // library reports nothing, the Jellyfin library index may have been dropped
    // (e.g. it judged the library path "inaccessible or empty" and removed the
    // folder item). Trigger a library refresh and retry once before giving up.
    if (seriesList.length === 0 && hasSonarrLinked) {
      try {
        await this.jellyfin.refreshLibrary();
        await sleep(this.options.rebuildDelayMs ?? 15_000);
        seriesList = await this.jellyfin.getSeries();
        if (seriesList.length > 0) {
          result.jellyfinRebuilt = true;
        }
      } catch {
        // Refresh is best-effort; a later sync retries.
      }
    }

    const sonarrSeriesList = this.sonarr ? await this.sonarr.getSeries() : [];

    const allSeasons = this.db.select().from(seasons).all();
    const seasonByAnime = new Map<number, typeof seasons.$inferSelect[]>();
    for (const season of allSeasons) {
      const list = seasonByAnime.get(season.animeId) ?? [];
      list.push(season);
      seasonByAnime.set(season.animeId, list);
    }
    const allEpisodes = this.db.select().from(episodes).all();

    for (const anime of animeRows) {
      if (anime.sonarrId == null && this.sonarr) {
        const linked = matchSonarrSeries(anime, sonarrSeriesList);
        if (linked) {
          const changes: Partial<typeof animes.$inferInsert> = { sonarrId: linked.id, updatedAt: Date.now() };
          if (anime.tvdbId == null) changes.tvdbId = linked.tvdbId;
          this.db.update(animes).set(changes).where(eq(animes.id, anime.id)).run();
          anime.sonarrId = linked.id;
          result.seriesLinked++;
        }
      }

      if (anime.sonarrId != null && this.sonarr) {
        try {
          const sonarrEpisodes = await this.sonarr.getEpisodes(anime.sonarrId);
          const existingSeasons = seasonByAnime.get(anime.id) ?? [];
          if (existingSeasons.length === 0) {
            const bySeason = new Map<number, { id: number; episodeNumber: number; absoluteEpisodeNumber: number | null }[]>();
            for (const ep of sonarrEpisodes) {
              const list = bySeason.get(ep.seasonNumber) ?? [];
              list.push(ep);
              bySeason.set(ep.seasonNumber, list);
            }
            for (const [number, eps] of bySeason) {
              const season = this.db
                .insert(seasons)
                .values({ animeId: anime.id, number })
                .returning()
                .get();
              for (const ep of eps) {
                this.db
                  .insert(episodes)
                  .values({
                    seasonId: season.id,
                    episodeNumber: ep.episodeNumber,
                    absoluteNumber: ep.absoluteEpisodeNumber,
                    sonarrEpisodeId: ep.id,
                  })
                  .run();
              }
            }
            const freshSeasons = this.db.select().from(seasons).where(eq(seasons.animeId, anime.id)).all();
            seasonByAnime.set(anime.id, freshSeasons);
            for (const season of freshSeasons) {
              allEpisodes.push(...this.db.select().from(episodes).where(eq(episodes.seasonId, season.id)).all());
            }
          } else {
            // Sonarr's episode list carries the TVDB titles (the same ones
            // its renamer uses). Backfill rows that have no real title yet;
            // existing titles are never overwritten and junk (series-name
            // fallbacks) is filtered through the same sanitizer as Jellyfin's.
            const titleByKey = new Map<string, string>();
            for (const ep of sonarrEpisodes) {
              if (ep.title) titleByKey.set(`${ep.seasonNumber}:${ep.episodeNumber}`, ep.title);
            }
            for (const season of existingSeasons) {
              for (const episode of allEpisodes.filter((e) => e.seasonId === season.id)) {
                if (episode.title != null) continue;
                const sonarrTitle = titleByKey.get(`${season.number}:${episode.episodeNumber}`);
                if (!sonarrTitle) continue;
                const clean = sanitizeEpisodeTitle(sonarrTitle, [
                  anime.titleRomaji,
                  anime.titleEnglish,
                  anime.titleNative,
                ]);
                if (clean != null) {
                  this.db
                    .update(episodes)
                    .set({ title: clean })
                    .where(eq(episodes.id, episode.id))
                    .run();
                }
              }
            }
          }
        } catch {
          // Materialization is best-effort; a later sync retries.
        }
      }

      const matched = matchSeries(anime, seriesList);
      if (!matched) continue;

      if (anime.jellyfinId !== matched.id) {
        this.db.update(animes).set({ jellyfinId: matched.id, updatedAt: Date.now() }).where(eq(animes.id, anime.id)).run();
      }
      result.seriesMatched++;

      let episodeItems: Awaited<ReturnType<JellyfinClient["getEpisodes"]>>;
      try {
        episodeItems = await this.jellyfin.getEpisodes(matched.id);
      } catch {
        // A broken/mismatched Jellyfin item must not kill the whole sync; a later sync retries.
        continue;
      }
      const itemByKey = new Map<string, (typeof episodeItems)[number]>();
      for (const item of episodeItems) {
        if (item.seasonNumber == null || item.episodeNumber == null) continue;
        itemByKey.set(`${item.seasonNumber}:${item.episodeNumber}`, item);
      }

      for (const season of seasonByAnime.get(anime.id) ?? []) {
        for (const episode of allEpisodes.filter((e) => e.seasonId === season.id)) {
          const item = itemByKey.get(`${season.number}:${episode.episodeNumber}`);
          if (!item) continue;

          const changes: Partial<typeof episodes.$inferInsert> = { available: true };
          if (episode.jellyfinItemId !== item.id) {
            changes.jellyfinItemId = item.id;
          }
          if (item.name) {
            const seriesTitles = [
              matched.title,
              anime.titleRomaji,
              anime.titleEnglish,
              anime.titleNative,
            ];
            const cleanTitle = sanitizeEpisodeTitle(item.name, seriesTitles);
            // A fallback name that sanitizes to null must not clobber a real
            // title (e.g. one backfilled from Sonarr); junk-to-null is fine.
            const currentIsJunk =
              episode.title != null && sanitizeEpisodeTitle(episode.title, seriesTitles) !== episode.title;
            if (episode.title !== cleanTitle && (cleanTitle != null || currentIsJunk)) {
              changes.title = cleanTitle;
            }
          }
          if (episode.thumbnailUrl !== item.thumbnailUrl) {
            changes.thumbnailUrl = item.thumbnailUrl;
          }

          if (item.userData) {
            if (item.userData.played) {
              changes.watched = true;
              changes.progressSeconds = 0;
              result.progressUpdated++;
            } else if (item.userData.positionTicks > 0) {
              changes.progressSeconds = Math.floor(item.userData.positionTicks / 10_000_000);
              result.progressUpdated++;
            }
          }

          this.db
            .update(episodes)
            .set(changes)
            .where(eq(episodes.id, episode.id))
            .run();
          result.episodesAvailable++;
        }
      }
    }

    return result;
  }
}
