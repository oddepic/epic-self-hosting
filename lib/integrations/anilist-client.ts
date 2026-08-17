import type { AniListClient, AniListItem } from "./types";
import { RateLimitedError } from "./errors";

const ANILIST_ENDPOINT = "https://graphql.anilist.co";

// Run a list of async tasks with a bounded concurrency, preserving order.
// AniList's rate limit (90 req/min) tolerates a few in-flight requests, and
// batching beats waiting for each page sequentially (e.g. a 600-entry MAL
// import goes from 12 serial calls to ~4 waves of 3).
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  synonyms
  description
  coverImage { extraLarge }
  bannerImage
  genres
  format
  startDate { year }
  episodes
  nextAiringEpisode { airingAt }
`;

const SEARCH_QUERY = `
query SearchAnime($search: String) {
  Page(page: 1, perPage: 20) {
    media(search: $search, type: ANIME) {
      ${MEDIA_FIELDS}
    }
  }
}
`;

interface AnilistMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[] | null;
  description: string | null;
  coverImage: { extraLarge: string | null };
  bannerImage: string | null;
  genres: string[] | null;
  format: string | null;
  startDate: { year: number | null };
  episodes: number | null;
  nextAiringEpisode: { airingAt: number } | null;
}

interface AnilistResponse {
  data?: { Page?: { media?: AnilistMedia[] } };
  errors?: { message: string }[];
}

export class AniListHttpClient implements AniListClient {
  constructor(private readonly endpoint = ANILIST_ENDPOINT) {}

  async search(query: string): Promise<AniListItem[]> {
    const body = await this.post<AnilistResponse>(SEARCH_QUERY, { search: query });
    return (body.data?.Page?.media ?? []).map(mapMedia);
  }

  async getById(id: number): Promise<AniListItem | null> {
    return this.mediaBy("id", id);
  }

  async getByMalId(malId: number): Promise<AniListItem | null> {
    return this.mediaBy("idMal", malId);
  }

  async getByMalIds(ids: number[]): Promise<AniListItem[]> {
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 50) {
      chunks.push(ids.slice(i, i + 50));
    }
    const results = await mapWithConcurrency(chunks, 3, async (chunk) => {
      const body = await this.post<AnilistResponse>(
        `
          query AnimeByMalIds($ids: [Int]) {
            Page(perPage: 50) {
              media(idMal_in: $ids, type: ANIME) {
                ${MEDIA_FIELDS}
              }
            }
          }
        `,
        { ids: chunk },
      );
      return (body.data?.Page?.media ?? []).map(mapMedia);
    });
    return results.flat();
  }

  async getAiringSchedule(ids: number[]): Promise<{ anilistId: number; airingAt: number | null; episode: number | null }[]> {
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 50) {
      chunks.push(ids.slice(i, i + 50));
    }
    const results = await mapWithConcurrency(chunks, 3, async (chunk) => {
      const body = await this.post<{
        data?: { Page?: { media?: { id: number; nextAiringEpisode: { airingAt: number; episode: number } | null }[] } };
        errors?: { message: string }[];
      }>(
        `
          query AiringSchedule($ids: [Int]) {
            Page(perPage: 50) {
              media(id_in: $ids, type: ANIME) {
                id
                nextAiringEpisode { airingAt episode }
              }
            }
          }
        `,
        { ids: chunk },
      );
      return (body.data?.Page?.media ?? []).map((media) => ({
        anilistId: media.id,
        // AniList airingAt is unix SECONDS; the app compares against
        // Date.now() (ms), so normalize here.
        airingAt: media.nextAiringEpisode?.airingAt != null ? media.nextAiringEpisode.airingAt * 1000 : null,
        episode: media.nextAiringEpisode?.episode ?? null,
      }));
    });
    return results.flat();
  }

  private async mediaBy(field: "id" | "idMal", value: number): Promise<AniListItem | null> {
    const body = await this.post<{
      data?: { Media?: AnilistMedia | null };
      errors?: { message: string }[];
    }>(
      `query AnimeBy${field}($id: Int) { Media(${field}: $id, type: ANIME) { ${MEDIA_FIELDS} } }`,
      { id: value },
    );
    const media = body.data?.Media;
    return media ? mapMedia(media) : null;
  }

  private async post<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const reset = response.headers.get("X-RateLimit-Reset");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : reset ? Number(reset) * 1000 : 60_000;
      throw new RateLimitedError(Number.isFinite(waitMs) ? waitMs : 60_000);
    }
    if (!response.ok) {
      throw new Error(`AniList responded ${response.status}`);
    }

    const body = (await response.json()) as T & { errors?: { message: string }[] };
    if (body.errors?.length) {
      throw new Error(body.errors[0]!.message);
    }
    return body;
  }
}

function mapMedia(m: AnilistMedia): AniListItem {
  return {
    id: m.id,
    malId: m.idMal,
    title: m.title,
    synonyms: m.synonyms ?? [],
    synopsis: stripHtml(m.description),
    coverImageUrl: m.coverImage.extraLarge,
    bannerImageUrl: m.bannerImage,
    genres: m.genres ?? [],
    format: m.format,
    seasonYear: m.startDate.year,
    episodeCount: m.episodes,
    // AniList airingAt is unix SECONDS; the app compares against Date.now()
    // (ms), so normalize here.
    nextEpisodeAt: m.nextAiringEpisode?.airingAt != null ? m.nextAiringEpisode.airingAt * 1000 : null,
  };
}

function stripHtml(input: string | null): string | null {
  if (!input) return null;
  return input.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();
}
