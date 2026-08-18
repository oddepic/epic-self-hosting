import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, malTokens, seasons } from "../db/schema";
import type { MalClient, MalListEntry, MalToken } from "../integrations/types";
import { MalHttpClient } from "../integrations/mal-client";
import { AniListHttpClient } from "../integrations/anilist-client";
import { MalImportService } from "./mal-import-service";
import type { AppConfig } from "../config";

const RETRY_DELAY_MS = 500;

export function createMalSync(db: Db, config: AppConfig): MalSyncService {
  const client = new MalHttpClient(config.malClientId, config.malClientSecret);
  return new MalSyncService(db, client, new MalImportService(db, client, new AniListHttpClient()));
}

export function createMalImport(db: Db, config: AppConfig): MalImportService {
  const client = new MalHttpClient(config.malClientId, config.malClientSecret);
  return new MalImportService(db, client, new AniListHttpClient());
}

export class MalSyncService {
  constructor(
    private readonly db: Db,
    private readonly mal: MalClient,
    private readonly importer: MalImportService,
    private readonly options: {
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      attempts?: number;
    } = {},
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private get sleep(): (ms: number) => Promise<void> {
    return this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async pushStatus(userId: number, animeId: number): Promise<void> {
    const anime = this.db.select().from(animes).where(eq(animes.id, animeId)).get();
    if (!anime || anime.malId == null) return;
    const tokens = await this.ensureTokens(userId);
    if (!tokens) return;
    await this.push(anime.malId, anime.status, anime.watchedEpisodes, anime.score, tokens);
  }

  async pushEpisodeCompletion(userId: number, episodeId: number): Promise<void> {
    const episode = this.db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    if (!episode) return;
    const season = this.db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
    if (!season) return;
    const anime = this.db.select().from(animes).where(eq(animes.id, season.animeId)).get();
    if (!anime || anime.malId == null) return;
    const tokens = await this.ensureTokens(userId);
    if (!tokens) return;

    // The entry-level counter is the source of truth (MAL counts across all
    // seasons of a single entry — One Piece, Naruto, etc.).
    const watched = anime.watchedEpisodes;
    const total = anime.episodeCount;
    const status =
      (anime.status === "watching" || anime.status === "completed") &&
      total != null &&
      total > 0 &&
      watched >= total
        ? "completed"
        : anime.status;
    await this.push(anime.malId, status, watched, anime.score, tokens);
  }

  unlink(userId: number): void {
    this.db.delete(malTokens).where(eq(malTokens.userId, userId)).run();
  }

  private async ensureTokens(userId: number): Promise<MalToken | null> {
    const tokens = this.importer.loadTokens(userId);
    if (!tokens) return null;
    return this.importer.ensureTokens(userId, tokens);
  }

  private async push(malId: number, status: MalListEntry["status"], watchedEpisodes: number, score: number | null, tokens: MalToken): Promise<void> {
    const attempts = this.options.attempts ?? 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.mal.updateStatus(tokens.accessToken, malId, status, watchedEpisodes, score);
        return;
      } catch (error) {
        if (attempt < attempts) {
          await this.sleep(RETRY_DELAY_MS);
        } else {
          console.error("MAL push failed after retries:", error);
        }
      }
    }
  }
}
