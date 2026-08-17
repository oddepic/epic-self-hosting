import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { animes, seasons, episodes, malTokens, users } from "../db/schema";
import { MalSyncService } from "./mal-sync-service";
import { MalImportService } from "./mal-import-service";
import type { AniListClient, MalClient, MalToken } from "../integrations/types";

const TOKEN: MalToken = { accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1_000_000 };

function seedAnime(db: Db, overrides: Partial<typeof animes.$inferInsert> = {}): { animeId: number; userId: number } {
  const user = db
    .insert(users)
    .values({ username: "admin", passwordHash: "x", preferences: {}, createdAt: 1 })
    .returning()
    .get();
  const anime = db
    .insert(animes)
    .values({
      anilistId: Math.floor(Math.random() * 1_000_000),
      malId: 12345,
      titleRomaji: "Any Anime",
      titleEnglish: "Any Anime",
      status: "watching",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    })
    .returning()
    .get();
  return { animeId: anime.id, userId: user.id };
}

function seedEpisodes(db: Db, animeId: number, watchedFlags: boolean[]): number[] {
  const season = db
    .insert(seasons)
    .values({ animeId, number: 1 })
    .returning()
    .get();
  const ids: number[] = [];
  for (const [index, watched] of watchedFlags.entries()) {
    const episode = db
      .insert(episodes)
      .values({
        seasonId: season.id,
        episodeNumber: index + 1,
        watched,
        progressSeconds: 0,
      })
      .returning()
      .get();
    ids.push(episode.id);
  }
  return ids;
}

function fakeMal(failuresBeforeSuccess = 0): MalClient & {
  updateCalls: { animeId: number; status: string; watchedEpisodes: number; score: number | null }[];
  refreshCalls: number;
} {
  const updateCalls: { animeId: number; status: string; watchedEpisodes: number; score: number | null }[] = [];
  const state = { refreshCalls: 0, failuresLeft: failuresBeforeSuccess };
  return {
    updateCalls,
    get refreshCalls() {
      return state.refreshCalls;
    },
    createAuthUrl() {
      return "http://auth";
    },
    async exchangeCode() {
      return TOKEN;
    },
    async getMyList() {
      return [];
    },
    async updateStatus(_accessToken: string, animeId: number, status: string, watchedEpisodes: number, score: number | null) {
      if (state.failuresLeft > 0) {
        state.failuresLeft--;
        throw new Error("MAL status update failed: 500");
      }
      updateCalls.push({ animeId, status, watchedEpisodes, score });
    },
    async refreshAccessToken() {
      state.refreshCalls++;
      return { accessToken: "acc-fresh", refreshToken: "ref-fresh", expiresAt: 2_000_000 };
    },
  };
}

function fakeAniList(): AniListClient {
  return {
    async search() {
      return [];
    },
    async getById() {
      return null;
    },
    async getByMalId() {
      return null;
    },
    async getByMalIds() {
      return [];
    },
    async getAiringSchedule() {
      return [];
    },
  };
}

function makeService(db: Db, mal: MalClient, now: () => number = () => 500_000): MalSyncService {
  const importer = new MalImportService(db, mal, fakeAniList(), { now });
  return new MalSyncService(db, mal, importer, { now, sleep: async () => {} });
}

describe("MalSyncService", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  describe("pushStatus", () => {
    it("pushes the current status and locally counted watched episodes", async () => {
      const { animeId, userId } = seedAnime(db, { score: 8 });
      seedEpisodes(db, animeId, [true, false, true]);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushStatus(userId, animeId);

      expect(mal.updateCalls).toEqual([
        { animeId: 12345, status: "watching", watchedEpisodes: 2, score: 8 },
      ]);
    });

    it("pushes the latest local status after changes", async () => {
      const { animeId, userId } = seedAnime(db);
      db.update(animes).set({ status: "dropped" }).where(eq(animes.id, animeId)).run();
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushStatus(userId, animeId);

      expect(mal.updateCalls).toEqual([{ animeId: 12345, status: "dropped", watchedEpisodes: 0, score: null }]);
    });

    it("refreshes expired tokens before pushing and persists the fresh pair", async () => {
      const { animeId, userId } = seedAnime(db);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal, () => 2_000_000);

      await service.pushStatus(userId, animeId);

      expect(mal.refreshCalls).toBe(1);
      expect(mal.updateCalls[0]!.animeId).toBe(12345);
      const stored = db.select().from(malTokens).where(eq(malTokens.userId, userId)).get();
      expect(stored!.accessToken).toBe("acc-fresh");
    });

    it("skips animes without a MAL id", async () => {
      const { animeId, userId } = seedAnime(db, { malId: null });
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushStatus(userId, animeId);

      expect(mal.updateCalls).toHaveLength(0);
    });

    it("skips when the user has no tokens linked", async () => {
      const { animeId, userId } = seedAnime(db);
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushStatus(userId, animeId);

      expect(mal.updateCalls).toHaveLength(0);
    });

    it("retries on failure and succeeds", async () => {
      const { animeId, userId } = seedAnime(db);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal(2);
      const service = makeService(db, mal);

      await service.pushStatus(userId, animeId);

      expect(mal.updateCalls).toHaveLength(1);
    });

    it("swallows persistent failure without throwing", async () => {
      const { animeId, userId } = seedAnime(db);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal(100);
      const service = makeService(db, mal);

      await expect(service.pushStatus(userId, animeId)).resolves.toBeUndefined();
    });
  });

  describe("pushEpisodeCompletion", () => {
    it("pushes the incremented watched count", async () => {
      const { animeId, userId } = seedAnime(db);
      const [ep1] = seedEpisodes(db, animeId, [true, false, false]);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushEpisodeCompletion(userId, ep1);

      expect(mal.updateCalls).toEqual([
        { animeId: 12345, status: "watching", watchedEpisodes: 1, score: null },
      ]);
    });

    it("auto-completes on MAL when every episode is watched", async () => {
      const { animeId, userId } = seedAnime(db);
      const eps = seedEpisodes(db, animeId, [true, true, true]);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushEpisodeCompletion(userId, eps[eps.length - 1]);

      expect(mal.updateCalls).toEqual([
        { animeId: 12345, status: "completed", watchedEpisodes: 3, score: null },
      ]);
    });

    it("does not auto-complete a dropped anime", async () => {
      const { animeId, userId } = seedAnime(db, { status: "dropped" });
      const eps = seedEpisodes(db, animeId, [true, true, true]);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushEpisodeCompletion(userId, eps[eps.length - 1]);

      expect(mal.updateCalls).toEqual([
        { animeId: 12345, status: "dropped", watchedEpisodes: 3, score: null },
      ]);
    });

    it("ignores specials (season 0) in the count and the total", async () => {
      const { animeId, userId } = seedAnime(db);
      const [ep1] = seedEpisodes(db, animeId, [true, false]);
      const specials = db.insert(seasons).values({ animeId, number: 0 }).returning().get();
      db.insert(episodes).values({ seasonId: specials.id, episodeNumber: 1, watched: true, progressSeconds: 0 }).run();
      db.insert(episodes).values({ seasonId: specials.id, episodeNumber: 2, watched: true, progressSeconds: 0 }).run();
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushEpisodeCompletion(userId, ep1);

      expect(mal.updateCalls).toEqual([
        { animeId: 12345, status: "watching", watchedEpisodes: 1, score: null },
      ]);
    });

    it("counts only the action season when the row overhangs its MAL entry", async () => {
      const { animeId, userId } = seedAnime(db, { episodeCount: 2 });
      seedEpisodes(db, animeId, [true, true]);
      const season2 = db.insert(seasons).values({ animeId, number: 2 }).returning().get();
      const s2e1 = db
        .insert(episodes)
        .values({ seasonId: season2.id, episodeNumber: 1, watched: true, progressSeconds: 0 })
        .returning()
        .get();
      db.insert(episodes).values({ seasonId: season2.id, episodeNumber: 2, watched: false, progressSeconds: 0 }).run();
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const mal = fakeMal();
      const service = makeService(db, mal);

      await service.pushEpisodeCompletion(userId, s2e1.id);

      expect(mal.updateCalls).toEqual([
        { animeId: 12345, status: "watching", watchedEpisodes: 1, score: null },
      ]);
    });
  });

  describe("unlink", () => {
    it("removes the stored tokens", () => {
      const { userId } = seedAnime(db);
      db.insert(malTokens).values({ userId, ...TOKEN, updatedAt: 1 }).run();
      const service = makeService(db, fakeMal());

      service.unlink(userId);

      expect(db.select().from(malTokens).all()).toHaveLength(0);
    });

    it("is idempotent when nothing is linked", () => {
      const { userId } = seedAnime(db);
      const service = makeService(db, fakeMal());

      expect(() => service.unlink(userId)).not.toThrow();
    });
  });
});


