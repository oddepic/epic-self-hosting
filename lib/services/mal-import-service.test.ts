import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, malTokens, users } from "../db/schema";
import { hashPassword } from "./user-service";
import { MalImportService } from "./mal-import-service";
import type { AniListClient, AniListItem, MalClient, MalListEntry, MalToken } from "../integrations/types";

function makeToken(overrides: Partial<MalToken> = {}): MalToken {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 9_999_999_999_999,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<MalListEntry> = {}): MalListEntry {
  return {
    animeId: 9756,
    title: "Fullmetal Alchemist: Brotherhood",
    status: "watching",
    watchedEpisodes: 5,
    ...overrides,
  };
}

function makeAniListItem(overrides: Partial<AniListItem> = {}): AniListItem {
  return {
    id: 5114,
    malId: 9756,
    title: { romaji: "Fullmetal Alchemist: Brotherhood", english: "Fullmetal Alchemist: Brotherhood", native: null },
    synonyms: [],
    synopsis: "Two brothers search for the Philosopher's Stone.",
    coverImageUrl: "https://example.com/cover.jpg",
    bannerImageUrl: null,
    genres: ["Action"],
    format: "TV",
    seasonYear: 2009,
    episodeCount: 64,
    nextEpisodeAt: null,
    ...overrides,
  };
}

function fakeMal(
  behavior: {
    entries?: MalListEntry[];
    refresh?: MalToken;
    refreshCalls?: number;
  } = {},
): MalClient & { refreshCount: () => number } {
  const state = { calls: 0 };
  return {
    refreshCount: () => state.calls,
    createAuthUrl: () => "https://mal/authorize",
    async exchangeCode() {
      return makeToken();
    },
    async getMyList() {
      return behavior.entries ?? [];
    },
    async updateStatus() {},
    async refreshAccessToken() {
      state.calls++;
      return behavior.refresh ?? makeToken({ accessToken: "refreshed-access", refreshToken: "refreshed-refresh", expiresAt: 9_999_999_999 });
    },
  };
}

function fakeAniList(
  behavior: { byMalId?: Record<number, AniListItem | null> } = {},
): AniListClient & { batchCalls: number[][] } {
  const batchCalls: number[][] = [];
  return {
    batchCalls,
    async search() {
      return [];
    },
    async getById() {
      return null;
    },
    async getByMalId(malId: number) {
      return behavior.byMalId?.[malId] ?? null;
    },
    async getByMalIds(ids: number[]) {
      batchCalls.push(ids);
      return ids
        .map((id) => behavior.byMalId?.[id])
        .filter((item): item is AniListItem => Boolean(item));
    },
    async getAiringSchedule() {
      return [];
    },
  };
}

async function seedUser(db: Db): Promise<number> {
  const user = db
    .insert(users)
    .values({ username: "admin", passwordHash: hashPassword("x"), preferences: {}, createdAt: 1 })
    .returning()
    .get();
  return user.id;
}

describe("MalImportService.importList", () => {
  let db: Db;
  let userId: number;

  beforeEach(async () => {
    db = createDb(":memory:");
    userId = await seedUser(db);
  });

  it("creates anime rows from the MAL list, enriched with AniList metadata", async () => {
    const mal = fakeMal({ entries: [makeEntry(), makeEntry({ animeId: 52991, title: "Frieren", status: "completed" })] });
    const anilist = fakeAniList({
      byMalId: {
        9756: makeAniListItem(),
        52991: makeAniListItem({ id: 154587, malId: 52991, title: { romaji: "Sousou no Frieren", english: "Frieren: Beyond Journey's End", native: null } }),
      },
    });
    const service = new MalImportService(db, mal, anilist);
    const result = await service.importList(userId, makeToken());

    expect(result).toMatchObject({ imported: 2, updated: 0, skipped: 0 });
    const rows = db.select().from(animes).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.malId === 9756)).toMatchObject({
      anilistId: 5114,
      status: "watching",
      coverImageUrl: "https://example.com/cover.jpg",
      synopsis: "Two brothers search for the Philosopher's Stone.",
    });
    expect(rows.find((r) => r.malId === 52991)!.status).toBe("completed");
  });

  it("updates the status of an existing anime matched by MAL id", async () => {
    db.insert(animes).values({
      anilistId: 5114,
      malId: 9756,
      titleRomaji: "Fullmetal Alchemist: Brotherhood",
      status: "plan_to_watch",
      createdAt: 1,
      updatedAt: 1,
    }).run();

    const mal = fakeMal({ entries: [makeEntry({ status: "dropped" })] });
    const service = new MalImportService(db, mal, fakeAniList());
    const result = await service.importList(userId, makeToken());

    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    const row = db.select().from(animes).where(eq(animes.malId, 9756)).get();
    expect(row!.status).toBe("dropped");
    expect(db.select().from(animes).all()).toHaveLength(1);
  });

  it("updates an existing anime matched by AniList id when MAL id differs", async () => {
    db.insert(animes).values({
      anilistId: 154587,
      malId: null,
      titleRomaji: "Sousou no Frieren",
      status: "plan_to_watch",
      createdAt: 1,
      updatedAt: 1,
    }).run();

    const mal = fakeMal({ entries: [makeEntry({ animeId: 52991, status: "watching" })] });
    const anilist = fakeAniList({
      byMalId: { 52991: makeAniListItem({ id: 154587, malId: 52991 }) },
    });
    const service = new MalImportService(db, mal, anilist);
    const result = await service.importList(userId, makeToken());

    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    const row = db.select().from(animes).where(eq(animes.anilistId, 154587)).get();
    expect(row!.status).toBe("watching");
    expect(db.select().from(animes).all()).toHaveLength(1);
  });

  it("is idempotent — a second import creates no duplicates", async () => {
    const mal = fakeMal({ entries: [makeEntry()] });
    const anilist = fakeAniList({ byMalId: { 9756: makeAniListItem() } });
    const service = new MalImportService(db, mal, anilist);
    await service.importList(userId, makeToken());
    const result = await service.importList(userId, makeToken());

    expect(result).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(db.select().from(animes).all()).toHaveLength(1);
  });

  it("skips entries with no AniList metadata", async () => {
    const mal = fakeMal({ entries: [makeEntry({ animeId: 1, title: "Obscure Thing" })] });
    const service = new MalImportService(db, mal, fakeAniList());
    const result = await service.importList(userId, makeToken());

    expect(result).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
    expect(db.select().from(animes).all()).toHaveLength(0);
  });

  it("refreshes an expired access token and persists the new one", async () => {
    const mal = fakeMal({ entries: [makeEntry()], refresh: makeToken({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 9_999_999_999_999 }) });
    const anilist = fakeAniList({ byMalId: { 9756: makeAniListItem() } });
    const service = new MalImportService(db, mal, anilist);
    const result = await service.importList(userId, makeToken({ expiresAt: 1 }));

    expect(mal.refreshCount()).toBe(1);
    expect(result.tokens).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    const stored = db.select().from(malTokens).get();
    expect(stored).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("does not refresh a still-valid token", async () => {
    const mal = fakeMal({ entries: [] });
    const service = new MalImportService(db, mal, fakeAniList());
    await service.importList(userId, makeToken());
    expect(mal.refreshCount()).toBe(0);
  });

  it("skips entries AniList has no record for", async () => {
    const mal = fakeMal({
      entries: [makeEntry({ animeId: 1 }), makeEntry({ animeId: 9756 })],
    });
    const anilist = fakeAniList({ byMalId: { 9756: makeAniListItem() } });
    const service = new MalImportService(db, mal, anilist);
    const result = await service.importList(userId, makeToken());

    expect(result).toMatchObject({ imported: 1, updated: 0, skipped: 1 });
    expect(db.select().from(animes).all()).toHaveLength(1);
  });

  it("skips all unmatched entries when the metadata fetch fails", async () => {
    const mal = fakeMal({
      entries: [makeEntry({ animeId: 1 }), makeEntry({ animeId: 9756 })],
    });
    const anilist = fakeAniList();
    anilist.getByMalIds = async () => {
      throw new Error("AniList down");
    };
    const service = new MalImportService(db, mal, anilist);
    const result = await service.importList(userId, makeToken());

    expect(result).toMatchObject({ imported: 0, updated: 0, skipped: 2 });
  });

  it("fetches metadata for unmatched entries in one batched call", async () => {
    const mal = fakeMal({ entries: [makeEntry({ animeId: 1 }), makeEntry({ animeId: 2 }), makeEntry({ animeId: 9756 })] });
    const anilist = fakeAniList({
      byMalId: {
        1: makeAniListItem({ id: 1, malId: 1 }),
        2: makeAniListItem({ id: 2, malId: 2 }),
        9756: makeAniListItem(),
      },
    });
    const service = new MalImportService(db, mal, anilist);
    const result = await service.importList(userId, makeToken());

    expect(anilist.batchCalls).toEqual([[1, 2, 9756]]);
    expect(result.imported).toBe(3);
  });
});

