import { and, eq, like, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons, type Anime } from "../db/schema";

const STATUS_ORDER = ["watching", "completed", "plan_to_watch", "on_hold", "dropped"] as const;

export type AnimeStatus = (typeof STATUS_ORDER)[number];

export interface LibraryItem extends Anime {
  watchedCount: number;
  totalCount: number;
}

export interface LibrarySection {
  status: AnimeStatus;
  count: number;
  items: LibraryItem[];
}

export interface LibraryQuery {
  search?: string;
  exclude?: AnimeStatus[];
}

export class LibraryService {
  constructor(private readonly db: Db) {}

  getLibrary(query: LibraryQuery = {}): LibrarySection[] {
    const conditions = [];
    if (query.search) {
      const term = `%${query.search.trim()}%`;
      conditions.push(
        or(
          like(animes.titleRomaji, term),
          like(animes.titleEnglish, term),
          like(animes.titleNative, term),
          like(animes.synonyms, term),
        ),
      );
    }

    const exclude = new Set(query.exclude ?? []);
    const all = this.db
      .select()
      .from(animes)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(animes.titleRomaji)
      .all();

    const counts = this.countsByAnime();
    const items = all.map((anime) => ({
      ...anime,
      watchedCount: counts.get(anime.id)?.watched ?? 0,
      totalCount: counts.get(anime.id)?.total ?? 0,
    }));

    const sections: LibrarySection[] = [];
    for (const status of STATUS_ORDER) {
      if (exclude.has(status)) continue;
      const sectionItems = items.filter((a) => a.status === status);
      if (sectionItems.length === 0) continue;
      sections.push({ status, count: sectionItems.length, items: sectionItems });
    }
    return sections;
  }

  private countsByAnime(): Map<number, { watched: number; total: number }> {
    const rows = this.db
      .select({
        animeId: seasons.animeId,
        watched: episodes.watched,
      })
      .from(episodes)
      .innerJoin(seasons, eq(seasons.id, episodes.seasonId))
      .all();
    const map = new Map<number, { watched: number; total: number }>();
    for (const row of rows) {
      const entry = map.get(row.animeId) ?? { watched: 0, total: 0 };
      entry.total++;
      if (row.watched) entry.watched++;
      map.set(row.animeId, entry);
    }
    return map;
  }

  setStatus(animeId: number, status: AnimeStatus): void {
    this.db.update(animes).set({ status, updatedAt: Date.now() }).where(eq(animes.id, animeId)).run();
  }
}
