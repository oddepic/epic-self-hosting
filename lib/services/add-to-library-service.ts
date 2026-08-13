import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import type { MonitorOption, SonarrClient, SonarrCandidate, SonarrEpisode } from "../integrations/types";
import type { AppConfig } from "../config";
import type { SearchItem } from "./search-service";
import { findSeasonMapping } from "./anime-season-map";

export class NoSonarrMatchError extends Error {
  constructor() {
    super("No match found in Sonarr");
  }
}

export class SonarrAddFailedError extends Error {
  constructor() {
    super("Sonarr rejected the add");
  }
}

function normalizeTitle(title: string): string {  return title
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const SEASON_PATTERNS = [
  { pattern: /part\s+(\d+)/i, direct: false },
  { pattern: /(\d+)(?:st|nd|rd|th)?\s+season/i, direct: true },
  { pattern: /season\s+(\d+)/i, direct: true },
  { pattern: /s(\d+)\b/i, direct: true },
  { pattern: /(\d+)(?:st|nd|rd|th)?\s+(?:stage|cour)/i, direct: false },
];

/**
 * Franchise folding: TVDB sometimes folds an anime's parts into a single parent
 * series where the part number differs from the TVDB season. Keyed by tvdbId,
 * maps the part/arc number to the actual TVDB season. From Anime-Lists
 * (anime-list-master.xml `defaulttvdbseason`).
 */
const FRANCHISE_PART_TO_SEASON: Record<number, Record<number, number>> = {
  // JoJo's Bizarre Adventure (2012): part -> tvdb season
  262954: { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6 },
};

const SUB_ENTRY_FORMATS = new Set(["ONA", "OVA", "MOVIE", "SPECIAL", "MUSIC"]);

function titleVariants(item: SearchItem): string[] {
  return [
    item.title,
    item.englishTitle,
    item.romajiTitle,
    item.nativeTitle,
    ...item.synonyms,
  ].filter((t): t is string => Boolean(t));
}

function foldSeason(tvdbId: number, partNumber: number): number {
  return FRANCHISE_PART_TO_SEASON[tvdbId]?.[partNumber] ?? partNumber;
}

/**
 * Resolves which season to monitor for an anime being added.
 *
 * Priority:
 * 1. The bundled Anime-Lists season map (anilist/mal -> tvdb season) — the
 *    authoritative source. Accepted only if the candidate's tvdbId matches the
 *    mapped series (protects against wrong-series lookups).
 * 2. An explicit season/part marker in any title variant or synonym
 *    ("4th Season", "Season 2", "s3", "Part 7", "1st STAGE"). "Part N" markers
 *    are checked first and folded through the franchise table (JoJo Part 7 ->
 *    tvdb season 6), so a part synonym beats a misleading "Nth STAGE" in the
 *    main title. Only accepted if the season exists in the candidate.
 * 3. A franchise sub-entry (ONA/OVA/Movie/Special, or a tiny episode count)
 *    that landed on a multi-season parent: default to the latest season so a
 *    single-part add never silently grabs the whole franchise.
 * 4. Otherwise undefined -> the caller monitors everything ("all").
 */
function resolveSeasonToMonitor(item: SearchItem, candidate: SonarrCandidate): number | undefined {
  const candidateSeasons = new Set(candidate.seasons.map((s) => s.seasonNumber));

  const mapping = findSeasonMapping(item.anilistId, item.malId);
  if (mapping && mapping.tvdbId === candidate.tvdbId && candidateSeasons.has(mapping.season)) {
    return mapping.season;
  }

  const texts = titleVariants(item);

  for (const { pattern, direct } of SEASON_PATTERNS) {
    for (const text of texts) {
      const match = text.match(pattern);
      if (!match) continue;
      const season = direct ? Number(match[1]) : foldSeason(candidate.tvdbId, Number(match[1]));
      if (candidateSeasons.has(season)) return season;
    }
  }

  const isSubEntry =
    (item.format != null && SUB_ENTRY_FORMATS.has(item.format.toUpperCase())) ||
    (item.episodeCount != null && item.episodeCount <= 3);
  if (isSubEntry) {
    const realSeasons = candidate.seasons.map((s) => s.seasonNumber).filter((n) => n > 0);
    if (realSeasons.length > 1) {
      return Math.max(...realSeasons);
    }
  }

  return undefined;
}

function suggestMonitor(item: SearchItem, candidate: SonarrCandidate): MonitorOption {
  const season = resolveSeasonToMonitor(item, candidate);
  return season != null ? { type: "specificSeason", season } : { type: "all" };
}

function isExactTitleMatch(candidate: SonarrCandidate, item: SearchItem): boolean {
  const name = normalizeTitle(candidate.title);
  const variants = [
    item.title,
    item.englishTitle,
    item.romajiTitle,
    item.nativeTitle,
    ...item.synonyms,
  ].filter((t): t is string => Boolean(t));
  return variants.some((v) => normalizeTitle(v) === name);
}

function scoreCandidate(
  candidate: SonarrCandidate,
  variants: string[],
  item: SearchItem,
): number {
  const name = normalizeTitle(candidate.title);
  let score = 0;

  if (variants.includes(name)) {
    score += 100;
  } else if (variants.some((v) => name.startsWith(v) || v.startsWith(name))) {
    score += 50;
  } else if (variants.some((v) => name.includes(v) || v.includes(name))) {
    score += 20;
  }

  if (candidate.year !== null && candidate.year === item.seasonYear) {
    score += 10;
  }

  return score;
}

export class AddToLibraryService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly sonarr: SonarrClient,
  ) {}

  async resolveCandidates(item: SearchItem): Promise<SonarrCandidate[]> {
    const titles = [
      item.title,
      item.englishTitle ?? item.title,
      item.romajiTitle ?? item.title,
      ...item.synonyms,
    ].filter((t, i, arr) => t && arr.indexOf(t) === i);

    const seen = new Set<number>();
    const candidates: SonarrCandidate[] = [];

    for (const title of titles) {
      let results: SonarrCandidate[];
      try {
        results = await this.sonarr.lookup(title);
      } catch {
        throw new Error("Sonarr lookup failed");
      }
      for (const candidate of results) {
        if (!seen.has(candidate.tvdbId)) {
          seen.add(candidate.tvdbId);
          candidates.push(candidate);
        }
      }
    }

    return this.rankCandidates(candidates, item);
  }

  async resolveBestMatch(
    item: SearchItem,
  ): Promise<{ matched: true; candidate: SonarrCandidate; monitor: MonitorOption } | { matched: false; candidates: SonarrCandidate[] }> {
    const prefixTerms: string[] = [];
    if (item.malId) prefixTerms.push(`mal:${item.malId}`);
    prefixTerms.push(`anilist:${item.anilistId}`);

    for (const term of prefixTerms) {
      let results: SonarrCandidate[];
      try {
        results = await this.sonarr.lookup(term);
      } catch {
        throw new Error("Sonarr lookup failed");
      }
      if (results.length === 1) {
        const candidate = results[0]!;
        return { matched: true, candidate, monitor: suggestMonitor(item, candidate) };
      }
      if (results.length > 1) break;
    }

    const candidates = await this.resolveCandidates(item);
    const exact = candidates.filter((c) => isExactTitleMatch(c, item));
    if (exact.length === 1) {
      const candidate = exact[0]!;
      return { matched: true, candidate, monitor: suggestMonitor(item, candidate) };
    }
    return { matched: false, candidates };
  }

  private rankCandidates(candidates: SonarrCandidate[], item: SearchItem): SonarrCandidate[] {
    const variants = [
      item.title,
      item.englishTitle,
      item.romajiTitle,
      item.nativeTitle,
      ...item.synonyms,
    ]
      .filter((t): t is string => Boolean(t))
      .map((t) => normalizeTitle(t));

    return [...candidates].sort((a, b) => scoreCandidate(b, variants, item) - scoreCandidate(a, variants, item));
  }

  async addToLibrary(item: SearchItem, candidate: SonarrCandidate, monitor?: MonitorOption): Promise<{ sonarrId: number }> {
    const effectiveMonitor: MonitorOption = monitor ?? suggestMonitor(item, candidate);
    let added: { id: number };
    try {
      added = await this.sonarr.addSeries(
        candidate,
        this.config.sonarrRootFolder,
        this.config.sonarrQualityProfileId,
        effectiveMonitor,
      );
    } catch {
      throw new SonarrAddFailedError();
    }

    let episodesBySeason: { seasonNumber: number; episodes: SonarrEpisode[] }[] = [];
    try {
      const sonarrEpisodes = await this.sonarr.getEpisodes(added.id);
      const bySeason = new Map<number, SonarrEpisode[]>();
      for (const ep of sonarrEpisodes) {
        const list = bySeason.get(ep.seasonNumber) ?? [];
        list.push(ep);
        bySeason.set(ep.seasonNumber, list);
      }
      episodesBySeason = [...bySeason.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([seasonNumber, episodes]) => ({ seasonNumber, episodes }));
    } catch {
      // Episode materialization is best-effort; the availability sync (ticket 07) heals later.
    }

    const now = Date.now();

    const existing = this.db
      .select()
      .from(animes)
      .where(
        sql`${animes.anilistId} = ${item.anilistId} OR ${animes.malId} = ${item.malId ?? -1} OR ${animes.tvdbId} = ${candidate.tvdbId}`,
      )
      .get();

    if (existing) {
      this.db
        .update(animes)
        .set({
          sonarrId: added.id,
          tvdbId: candidate.tvdbId,
          updatedAt: now,
        })
        .where(eq(animes.id, existing.id))
        .run();
      this.materializeEpisodes(existing.id, episodesBySeason);
      return { sonarrId: added.id };
    }

    const anime = this.db
      .insert(animes)
      .values({
        anilistId: item.anilistId,
        malId: item.malId,
        tvdbId: candidate.tvdbId,
        sonarrId: added.id,
        titleRomaji: item.romajiTitle ?? item.title,
        titleEnglish: item.englishTitle,
        titleNative: item.nativeTitle,
        synonyms: item.synonyms,
        synopsis: item.synopsis,
        coverImageUrl: item.coverImageUrl,
        bannerImageUrl: item.bannerImageUrl,
        genres: item.genres,
        format: item.format,
        seasonYear: item.seasonYear,
        episodeCount: item.episodeCount,
        nextEpisodeAt: item.nextEpisodeAt,
        status: "plan_to_watch",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    this.materializeEpisodes(anime.id, episodesBySeason);
    return { sonarrId: added.id };
  }

  private materializeEpisodes(
    animeId: number,
    episodesBySeason: { seasonNumber: number; episodes: SonarrEpisode[] }[],
  ): void {
    const existingSeasons = this.db.select().from(seasons).where(eq(seasons.animeId, animeId)).all();
    const existingEpisodeKeys = new Set<string>();
    const existingSeasonByNumber = new Map<number, number>();
    for (const season of existingSeasons) {
      existingSeasonByNumber.set(season.number, season.id);
      const eps = this.db.select().from(episodes).where(eq(episodes.seasonId, season.id)).all();
      for (const ep of eps) {
        existingEpisodeKeys.add(`${season.number}:${ep.episodeNumber}`);
      }
    }

    for (const { seasonNumber, episodes: seasonEpisodes } of episodesBySeason) {
      let seasonId = existingSeasonByNumber.get(seasonNumber);
      if (!seasonId) {
        const season = this.db
          .insert(seasons)
          .values({ animeId, number: seasonNumber })
          .returning()
          .get();
        seasonId = season.id;
        existingSeasonByNumber.set(seasonNumber, seasonId);
      }
      for (const ep of seasonEpisodes) {
        if (existingEpisodeKeys.has(`${seasonNumber}:${ep.episodeNumber}`)) continue;
        this.db
          .insert(episodes)
          .values({
            seasonId,
            episodeNumber: ep.episodeNumber,
            absoluteNumber: ep.absoluteEpisodeNumber,
            sonarrEpisodeId: ep.id,
          })
          .run();
      }
    }
  }
}
