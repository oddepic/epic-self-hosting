import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { getFranchise, resolveEntrySeason } from "./franchise-service";

describe("resolveEntrySeason", () => {
  let db: Db;
  let animeId: number;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  function seedEntry(overrides: Partial<typeof animes.$inferInsert> = {}): number {
    return db
      .insert(animes)
      .values({
        anilistId: Math.floor(Math.random() * 1_000_000),
        titleRomaji: "Any Anime",
        status: "watching",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      })
      .returning()
      .get().id;
  }

  function seedSeason(number: number, year: number | null = null, episodeTotal = 0): number {
    const id = db.insert(seasons).values({ animeId, number, year }).returning().get().id;
    for (let n = 1; n <= episodeTotal; n++) {
      db.insert(episodes).values({ seasonId: id, episodeNumber: n }).run();
    }
    return id;
  }

  it("maps by premiere year (exact)", () => {
    animeId = seedEntry({ seasonYear: 2025, episodeCount: 13 });
    seedSeason(1, 2018, 13);
    const s2 = seedSeason(2, 2025, 13);

    expect(resolveEntrySeason(db, db.select().from(animes).where(eq(animes.id, animeId)).get()!)?.id).toBe(s2);
  });

  it("maps within ±1 year (fall/winter splits)", () => {
    animeId = seedEntry({ seasonYear: 2026, episodeCount: 10 });
    seedSeason(1, 2023, 28);
    const s2 = seedSeason(2, 2025, 10);

    expect(resolveEntrySeason(db, db.select().from(animes).where(eq(animes.id, animeId)).get()!)?.id).toBe(s2);
  });

  it("falls back to the count coincidence when seasons have no years", () => {
    animeId = seedEntry({ episodeCount: 13 });
    seedSeason(1, null, 12);
    const s2 = seedSeason(2, null, 13);

    expect(resolveEntrySeason(db, db.select().from(animes).where(eq(animes.id, animeId)).get()!)?.id).toBe(s2);
  });

  it("never maps specials (D1) even when the year matches", () => {
    animeId = seedEntry({ seasonYear: 2018, episodeCount: 13 });
    seedSeason(0, 2018, 5);
    const s1 = seedSeason(1, 2018, 13);

    expect(resolveEntrySeason(db, db.select().from(animes).where(eq(animes.id, animeId)).get()!)?.id).toBe(s1);
  });

  it("returns null when nothing matches", () => {
    animeId = seedEntry({ seasonYear: 2030, episodeCount: 7 });
    seedSeason(1, 2018, 13);

    expect(resolveEntrySeason(db, db.select().from(animes).where(eq(animes.id, animeId)).get()!)).toBeNull();
  });
});

describe("getFranchise", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  function seedEntry(overrides: Partial<typeof animes.$inferInsert> & { sonarrId?: number }): number {
    return db
      .insert(animes)
      .values({
        anilistId: Math.floor(Math.random() * 1_000_000),
        titleRomaji: "Any Anime",
        status: "watching",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      })
      .returning()
      .get().id;
  }

  it("groups entries sharing a Sonarr series and assigns one owner per season", () => {
    const old = seedEntry({ sonarrId: 35, seasonYear: 2018 });
    const newEntry = seedEntry({ sonarrId: 35, seasonYear: 2025 });
    for (const animeId of [old, newEntry]) {
      seedSpecials(db, animeId);
      const s1 = db.insert(seasons).values({ animeId, number: 1, year: 2018 }).returning().get();
      const s2 = db.insert(seasons).values({ animeId, number: 2, year: 2025 }).returning().get();
      for (const s of [s1, s2]) {
        for (let n = 1; n <= 3; n++) db.insert(episodes).values({ seasonId: s.id, episodeNumber: n }).run();
      }
    }

    const franchise = getFranchise(db, newEntry);

    expect(franchise.members.map((m) => m.anime.id).sort()).toEqual([old, newEntry].sort());
    expect(franchise.seasons.map((s) => s.number)).toEqual([0, 1, 2]);
    const byNumber = new Map(franchise.seasons.map((s) => [s.number, s]));
    expect(byNumber.get(1)!.ownerAnimeId).toBe(old); // mapped by year
    expect(byNumber.get(2)!.ownerAnimeId).toBe(newEntry);
    expect(byNumber.get(0)!.isSpecials).toBe(true);
    expect(byNumber.get(0)!.ownerAnimeId).toBe(old); // unmapped → earliest member
  });

  it("keeps unlinked entries standalone", () => {
    const solo = seedEntry({});
    const franchise = getFranchise(db, solo);
    expect(franchise.members).toHaveLength(1);
    expect(franchise.members[0]!.anime.id).toBe(solo);
  });

  it("returns empty for unknown ids", () => {
    expect(getFranchise(db, 999_999)).toEqual({ members: [], seasons: [] });
  });
});

function seedSpecials(db: Db, animeId: number): void {
  const id = db.insert(seasons).values({ animeId, number: 0 }).returning().get().id;
  db.insert(episodes).values({ seasonId: id, episodeNumber: 1 }).run();
}
