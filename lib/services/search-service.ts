import type { AniListClient, AniListItem } from "../integrations/types";
import { RateLimitedError, SearchFailedError } from "../integrations/errors";

export interface SearchItem {
  anilistId: number;
  malId: number | null;
  title: string;
  romajiTitle: string | null;
  englishTitle: string | null;
  nativeTitle: string | null;
  synonyms: string[];
  synopsis: string | null;
  coverImageUrl: string | null;
  bannerImageUrl: string | null;
  genres: string[];
  format: string | null;
  seasonYear: number | null;
  episodeCount: number | null;
  nextEpisodeAt: number | null;
}

export class SearchService {
  private readonly cache = new Map<string, { expiresAt: number; items: SearchItem[] }>();

  constructor(
    private readonly client: AniListClient,
    private readonly options: {
      maxRetries?: number;
      cacheTtlMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {}

  async search(query: string): Promise<SearchItem[]> {
    const now = this.options.now?.() ?? Date.now();
    const cached = this.cache.get(query);
    if (cached && cached.expiresAt > now) return cached.items;

    const maxRetries = this.options.maxRetries ?? 2;
    let items: AniListItem[];
    try {
      items = await this.withRetry(query, maxRetries);
    } catch {
      throw new SearchFailedError();
    }

    const mapped = items.map(toSearchItem);
    this.cache.set(query, {
      expiresAt: now + (this.options.cacheTtlMs ?? 60_000),
      items: mapped,
    });
    return mapped;
  }

  private async withRetry(query: string, retriesLeft: number): Promise<AniListItem[]> {
    try {
      return await this.client.search(query);
    } catch (error) {
      if (error instanceof RateLimitedError && retriesLeft > 0) {
        await (this.options.sleep ?? sleep)(error.retryAfterMs);
        return this.withRetry(query, retriesLeft - 1);
      }
      throw error;
    }
  }
}

function toSearchItem(item: AniListItem): SearchItem {
  return {
    anilistId: item.id,
    malId: item.malId,
    title: item.title.english ?? item.title.romaji ?? item.title.native ?? "",
    romajiTitle: item.title.romaji,
    englishTitle: item.title.english,
    nativeTitle: item.title.native,
    synonyms: item.synonyms,
    synopsis: item.synopsis,
    coverImageUrl: item.coverImageUrl,
    bannerImageUrl: item.bannerImageUrl,
    genres: item.genres,
    format: item.format,
    seasonYear: item.seasonYear,
    episodeCount: item.episodeCount,
    nextEpisodeAt: item.nextEpisodeAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
