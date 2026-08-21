import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons, type Anime, type Season } from "../db/schema";

// Entry↔season mapping + franchise grouping.
//
// One Sonarr series covers a whole franchise, and every MAL entry of that
// franchise carries ALL of its seasons. To know which local season an entry
// actually is (for progress math and the modal default), we map by premiere
// year: the entry's AniList start year vs the season's first-air year (from
// Sonarr air dates). Specials (S0) are excluded per D1 — they are a separate
// scale and never represent an entry. Fallback when years are unknown: the old
// count coincidence (season episode count == entry total).

export function resolveEntrySeason(db: Db, anime: Anime): Season | null {
  const rows = db.select().from(seasons).where(eq(seasons.animeId, anime.id)).orderBy(seasons.number).all();
  const main = rows.filter((s) => s.number >= 1);
  if (main.length === 0) return null; // specials only — never represents an entry (D1)

  // Preferred: premiere-year match (±1 tolerates fall/winter splits).
  if (anime.seasonYear != null) {
    let best: Season | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const season of main) {
      if (season.year == null) continue;
      const dist = Math.abs(season.year - anime.seasonYear);
      if (dist <= 1 && dist < bestDist) {
        best = season;
        bestDist = dist;
      }
    }
    if (best != null) return best;
  }

  // Fallback: count coincidence (pre-backfill data). Highest season wins ties.
  if (anime.episodeCount != null) {
    let best: Season | null = null;
    for (const season of main) {
      const count =
        db
          .select({ count: sql<number>`count(*)` })
          .from(episodes)
          .where(eq(episodes.seasonId, season.id))
          .get()?.count ?? 0;
      if (count === anime.episodeCount && (best == null || season.number > best.number)) {
        best = season;
      }
    }
    if (best != null) return best;
  }

  return null;
}

export interface FranchiseMember {
  anime: Anime;
  /** The local season this entry maps to (null when it cannot be determined). */
  entrySeasonNumber: number | null;
}

export interface FranchiseSeason {
  number: number;
  isSpecials: boolean;
  /** Canonical member supplying this season's episode rows. */
  ownerAnimeId: number;
  ownerSeasonId: number;
  watchedCount: number;
  totalCount: number;
  availableCount: number;
  year: number | null;
}

export interface FranchiseInfo {
  /** Every entry of the franchise (same Sonarr series); includes the clicked one. */
  members: FranchiseMember[];
  /** Union of seasons across members, deduped by number, ascending. */
  seasons: FranchiseSeason[];
}

function seasonCounts(db: Db, seasonId: number): { watchedCount: number; totalCount: number; availableCount: number } {
  const rows = db
    .select({
      watched: episodes.watched,
      available: episodes.available,
    })
    .from(episodes)
    .where(eq(episodes.seasonId, seasonId))
    .all();
  return {
    totalCount: rows.length,
    watchedCount: rows.filter((r) => r.watched).length,
    availableCount: rows.filter((r) => r.available).length,
  };
}

// Group the clicked entry with every other entry sharing its Sonarr series and
// assign each season number a canonical owner member (its mapped entry when
// known, otherwise the earliest member carrying that season).
export function getFranchise(db: Db, animeId: number): FranchiseInfo {
  const clicked = db.select().from(animes).where(eq(animes.id, animeId)).get();
  if (!clicked) return { members: [], seasons: [] };

  const memberRows = clicked.sonarrId != null
    ? db.select().from(animes).where(eq(animes.sonarrId, clicked.sonarrId)).orderBy(animes.id).all()
    : [clicked];

  const members: FranchiseMember[] = memberRows.map((anime) => ({
    anime,
    entrySeasonNumber: resolveEntrySeason(db, anime)?.number ?? null,
  }));

  // Collect the union of season numbers with candidate (member, season) pairs.
  const candidatesByNumber = new Map<number, Array<{ member: FranchiseMember; season: Season }>>();
  for (const member of members) {
    const memberSeasons = db.select().from(seasons).where(eq(seasons.animeId, member.anime.id)).all();
    for (const season of memberSeasons) {
      const list = candidatesByNumber.get(season.number) ?? [];
      list.push({ member, season });
      candidatesByNumber.set(season.number, list);
    }
  }

  const franchiseSeasons: FranchiseSeason[] = [...candidatesByNumber.keys()].sort((a, b) => a - b).map((number) => {
    const candidates = candidatesByNumber.get(number)!;
    const mapped = candidates.find((c) => c.member.entrySeasonNumber === number);
    // Prefer the entry that owns this season; ties/none → earliest member id.
    const picked =
      mapped ??
      [...candidates].sort(
        (a, b) => a.member.anime.id - b.member.anime.id || a.season.id - b.season.id,
      )[0]!;
    const counts = seasonCounts(db, picked.season.id);
    return {
      number,
      isSpecials: number === 0,
      ownerAnimeId: picked.member.anime.id,
      ownerSeasonId: picked.season.id,
      ...counts,
      year: picked.season.year,
    };
  });

  return { members, seasons: franchiseSeasons };
}
