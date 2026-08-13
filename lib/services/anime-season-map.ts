import animeSeasonMap from "../data/anime-season-map.json";

export interface SeasonMapping {
  tvdbId: number;
  season: number;
}

interface SeasonMapEntry {
  anilist: number | null;
  mal: number | null;
  tvdb: number;
  season: number;
}

const byAnilist = new Map<number, SeasonMapping>();
const byMal = new Map<number, SeasonMapping>();

for (const entry of animeSeasonMap as SeasonMapEntry[]) {
  const mapping: SeasonMapping = { tvdbId: entry.tvdb, season: entry.season };
  if (entry.anilist != null) byAnilist.set(entry.anilist, mapping);
  if (entry.mal != null) byMal.set(entry.mal, mapping);
}

export function findSeasonMapping(anilistId: number | null, malId: number | null): SeasonMapping | null {
  if (anilistId != null) {
    const byAnilistHit = byAnilist.get(anilistId);
    if (byAnilistHit) return byAnilistHit;
  }
  if (malId != null) {
    const byMalHit = byMal.get(malId);
    if (byMalHit) return byMalHit;
  }
  return null;
}
