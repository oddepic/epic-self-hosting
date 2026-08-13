import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes } from "../db/schema";
import { LibraryService } from "./library-service";

function seedAnime(db: Db, overrides: Partial<typeof animes.$inferInsert> = {}): number {
  const row = db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      titleRomaji: "Test Anime",
      status: "plan_to_watch",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .returning()
    .get();
  return row.id;
}

describe("LibraryService.getLibrary", () => {
  let db: Db;
  let service: LibraryService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new LibraryService(db);
  });

  it("returns only non-empty status sections with counts", () => {
    seedAnime(db, { titleRomaji: "A", status: "watching" });
    seedAnime(db, { titleRomaji: "B", status: "completed" });
    seedAnime(db, { titleRomaji: "C", status: "completed" });
    seedAnime(db, { titleRomaji: "D", status: "dropped" });

    const library = service.getLibrary();
    expect(library.map((s) => [s.status, s.count])).toEqual([
      ["watching", 1],
      ["completed", 2],
      ["dropped", 1],
    ]);
    expect(library.find((s) => s.status === "watching")!.items[0]!.titleRomaji).toBe("A");
  });

  it("returns an empty list for an empty library", () => {
    expect(service.getLibrary()).toEqual([]);
  });

  it("searches across romaji, english, native, and synonyms", () => {
    seedAnime(db, { titleRomaji: "Sousou no Frieren", titleEnglish: "Frieren: Beyond Journey's End", titleNative: "葬送のフリーレン", synonyms: ["Frieren"], status: "watching" });
    seedAnime(db, { titleRomaji: "Fullmetal Alchemist", synonyms: ["FMA", "Hagane"], status: "completed" });
    seedAnime(db, { titleRomaji: "Steins;Gate", status: "plan_to_watch" });

    expect(service.getLibrary({ search: "Frieren" }).flatMap((s) => s.items)).toHaveLength(1);
    expect(service.getLibrary({ search: "Sousou" }).flatMap((s) => s.items)).toHaveLength(1);
    expect(service.getLibrary({ search: "葬送" }).flatMap((s) => s.items)).toHaveLength(1);
    expect(service.getLibrary({ search: "FMA" }).flatMap((s) => s.items)).toHaveLength(1);
    expect(service.getLibrary({ search: "Steins" }).flatMap((s) => s.items)).toHaveLength(1);
    expect(service.getLibrary({ search: "nothing-matches" }).flatMap((s) => s.items)).toHaveLength(0);
  });

  it("excludes the requested status sections", () => {
    seedAnime(db, { titleRomaji: "A", status: "watching" });
    seedAnime(db, { titleRomaji: "B", status: "completed" });
    seedAnime(db, { titleRomaji: "C", status: "dropped" });

    const library = service.getLibrary({ exclude: ["completed", "dropped"] });
    expect(library.map((s) => s.status)).toEqual(["watching"]);
  });

  it("orders sections by status order and items by title", () => {
    seedAnime(db, { titleRomaji: "Zed", status: "watching" });
    seedAnime(db, { titleRomaji: "Alpha", status: "watching" });
    seedAnime(db, { titleRomaji: "Beta", status: "plan_to_watch" });

    const library = service.getLibrary();
    expect(library.map((s) => s.status)).toEqual(["watching", "plan_to_watch"]);
    expect(library[0]!.items.map((i) => i.titleRomaji)).toEqual(["Alpha", "Zed"]);
  });
});

describe("LibraryService.setStatus", () => {
  let db: Db;
  let service: LibraryService;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new LibraryService(db);
  });

  it("persists the new status", () => {
    const id = seedAnime(db, { status: "plan_to_watch" });
    service.setStatus(id, "completed");
    const row = db.select().from(animes).all()[0]!;
    expect(row.status).toBe("completed");
  });

  it("moves the anime to the new section on the next query", () => {
    const id = seedAnime(db, { status: "plan_to_watch" });
    service.setStatus(id, "dropped");
    const library = service.getLibrary();
    expect(library.find((s) => s.status === "plan_to_watch")).toBeUndefined();
    expect(library.find((s) => s.status === "dropped")!.items.map((i) => i.id)).toEqual([id]);
  });

  it("includes per-anime watched and total episode counts", () => {
    const anime = db
      .insert(animes)
      .values({ anilistId: 77, titleRomaji: "Counts", status: "watching", createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    const season = db
      .insert(seasons)
      .values({ animeId: anime.id, number: 1 })
      .returning()
      .get();
    db.insert(episodes).values({ seasonId: season.id, episodeNumber: 1, watched: true }).run();
    db.insert(episodes).values({ seasonId: season.id, episodeNumber: 2, watched: false }).run();
    db.insert(episodes).values({ seasonId: season.id, episodeNumber: 3, watched: true }).run();

    const item = service.getLibrary().find((s) => s.status === "watching")!.items[0]!;

    expect(item.watchedCount).toBe(2);
    expect(item.totalCount).toBe(3);
  });
});
