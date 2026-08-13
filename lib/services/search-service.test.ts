import { describe, it, expect, vi } from "vitest";
import { SearchService } from "./search-service";
import { RateLimitedError, SearchFailedError } from "../integrations/errors";
import type { AniListClient, AniListItem } from "../integrations/types";

function makeItem(overrides: Partial<AniListItem> = {}): AniListItem {
  return {
    id: 5114,
    malId: 9756,
    title: { romaji: "Fullmetal Alchemist: Brotherhood", english: "Fullmetal Alchemist: Brotherhood", native: "鋼の錬金術師 FULLMETAL ALCHEMIST" },
    synonyms: ["FMA Brotherhood", "Hagane no Renkinjutsushi: Fullmetal Alchemist"],
    synopsis: "Two brothers search for the Philosopher's Stone.",
    coverImageUrl: "https://example.com/cover.jpg",
    bannerImageUrl: "https://example.com/banner.jpg",
    genres: ["Action", "Drama"],
    format: "TV",
    seasonYear: 2009,
    episodeCount: 64,
    nextEpisodeAt: null,
    ...overrides,
  };
}

function fakeClient(behavior: {
  results?: AniListItem[][];
  failTimes?: number;
} = {}): AniListClient & { calls: string[] } {
  const { results = [], failTimes = 0 } = behavior;
  const calls: string[] = [];
  const client: AniListClient & { calls: string[] } = {
    calls,
    async search(query: string) {
      calls.push(query);
      if (calls.length <= failTimes) {
        throw new RateLimitedError(60_000);
      }
      if (results.length > 0) {
        return results[Math.min(calls.length - 1 - failTimes, results.length - 1)]!;
      }
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
  return client;
}

describe("SearchService.search", () => {
  it("maps adapter results to search items with all metadata", async () => {
    const client = fakeClient({ results: [[makeItem()]] });
    const service = new SearchService(client);
    const items = await service.search("Fullmetal");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      anilistId: 5114,
      malId: 9756,
      title: "Fullmetal Alchemist: Brotherhood",
      romajiTitle: "Fullmetal Alchemist: Brotherhood",
      nativeTitle: "鋼の錬金術師 FULLMETAL ALCHEMIST",
      synonyms: ["FMA Brotherhood", "Hagane no Renkinjutsushi: Fullmetal Alchemist"],
      synopsis: "Two brothers search for the Philosopher's Stone.",
      coverImageUrl: "https://example.com/cover.jpg",
      bannerImageUrl: "https://example.com/banner.jpg",
      genres: ["Action", "Drama"],
      format: "TV",
      seasonYear: 2009,
      episodeCount: 64,
    });
  });

  it("passes the raw query through to the adapter", async () => {
    const client = fakeClient();
    const service = new SearchService(client);
    await service.search("Frieren");
    expect(client.calls).toEqual(["Frieren"]);
  });

  it("retries when the adapter reports a rate limit, respecting the wait", async () => {
    const client = fakeClient({ failTimes: 1, results: [[makeItem()]] });
    const sleep = vi.fn(async () => {});
    const service = new SearchService(client, { sleep });
    const items = await service.search("Fullmetal");
    expect(items).toHaveLength(1);
    expect(client.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("fails with a readable error after exhausting retries", async () => {
    const client = fakeClient({ failTimes: 99 });
    const service = new SearchService(client, { maxRetries: 2, sleep: async () => {} });
    await expect(service.search("Fullmetal")).rejects.toThrow(SearchFailedError);
    expect(client.calls).toHaveLength(3);
  });

  it("maps unknown adapter errors to a readable failure", async () => {
    const client = fakeClient();
    const service = new SearchService(client);
    client.search = async () => {
      throw new Error("network down");
    };
    await expect(service.search("Fullmetal")).rejects.toThrow(SearchFailedError);
  });

  it("does not re-call the adapter for an identical query within the cache window", async () => {
    const client = fakeClient({ results: [[makeItem()]] });
    const service = new SearchService(client);
    await service.search("Frieren");
    await service.search("Frieren");
    expect(client.calls).toHaveLength(1);
  });

  it("re-queries after the cache window expires", async () => {
    let now = 1_000;
    const client = fakeClient({ results: [[makeItem()]] });
    const service = new SearchService(client, { cacheTtlMs: 5_000, now: () => now });
    await service.search("Frieren");
    now = 10_000;
    await service.search("Frieren");
    expect(client.calls).toHaveLength(2);
  });

  it("does not cache failures", async () => {
    const client = fakeClient({ failTimes: 99 });
    const service = new SearchService(client, { maxRetries: 0, sleep: async () => {} });
    await expect(service.search("Frieren")).rejects.toThrow(SearchFailedError);
    await expect(service.search("Frieren")).rejects.toThrow(SearchFailedError);
    expect(client.calls).toHaveLength(2);
  });
});

