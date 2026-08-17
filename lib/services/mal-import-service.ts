import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, malTokens } from "../db/schema";
import type { AniListClient, MalClient, MalListEntry, MalToken } from "../integrations/types";

export interface MalImportResult {
  imported: number;
  updated: number;
  skipped: number;
  tokens: MalToken;
}

export class MalImportService {
  constructor(
    private readonly db: Db,
    private readonly mal: MalClient,
    private readonly anilist: AniListClient,
    private readonly options: {
      now?: () => number;
    } = {},
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  async importList(userId: number, tokens: MalToken): Promise<MalImportResult> {
    const current = await this.ensureTokens(userId, tokens);

    const entries = await this.mal.getMyList(current.accessToken);
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    const matched: { entry: MalListEntry; animeId: number }[] = [];
    const unmatched: MalListEntry[] = [];
    for (const entry of entries) {
      const byMalId = this.db.select().from(animes).where(eq(animes.malId, entry.animeId)).get();
      if (byMalId) {
        matched.push({ entry, animeId: byMalId.id });
      } else {
        unmatched.push(entry);
      }
    }

    let metadataByMalId = new Map<number, Awaited<ReturnType<AniListClient["getByMalIds"]>>[number]>();
    if (unmatched.length > 0) {
      try {
        const items = await this.anilist.getByMalIds(unmatched.map((e) => e.animeId));
        metadataByMalId = new Map(items.map((item) => [item.malId as number, item]));
      } catch {
        // Entries without metadata are counted as skipped below.
      }
    }

    this.db.transaction((tx) => {
      for (const { entry, animeId } of matched) {
        tx.update(animes).set({ status: entry.status, score: entry.score, updatedAt: this.now() }).where(eq(animes.id, animeId)).run();
        updated++;
      }

      for (const entry of unmatched) {
        const metadata = metadataByMalId.get(entry.animeId);
        if (metadata) {
          const byAniListId = tx.select().from(animes).where(eq(animes.anilistId, metadata.id)).get();
          if (byAniListId) {
            tx.update(animes).set({ status: entry.status, malId: entry.animeId, score: entry.score, updatedAt: this.now() }).where(eq(animes.id, byAniListId.id)).run();
            updated++;
          } else {
            const now = this.now();
            tx
              .insert(animes)
              .values({
                anilistId: metadata.id,
                malId: metadata.malId,
                titleRomaji: metadata.title.romaji ?? metadata.title.english ?? metadata.title.native ?? entry.title ?? "",
                titleEnglish: metadata.title.english,
                titleNative: metadata.title.native,
                synonyms: metadata.synonyms,
                synopsis: metadata.synopsis,
                coverImageUrl: metadata.coverImageUrl,
                bannerImageUrl: metadata.bannerImageUrl,
                genres: metadata.genres,
                format: metadata.format,
                seasonYear: metadata.seasonYear,
                episodeCount: metadata.episodeCount,
                nextEpisodeAt: metadata.nextEpisodeAt,
                status: entry.status,
                score: entry.score,
                createdAt: now,
                updatedAt: now,
              })
              .run();
            imported++;
          }
        } else {
          skipped++;
        }
      }
    });

    return { imported, updated, skipped, tokens: current };
  }

  async ensureTokens(userId: number, tokens: MalToken): Promise<MalToken> {
    if (tokens.expiresAt <= this.now()) {
      const fresh = await this.mal.refreshAccessToken(tokens.refreshToken);
      this.saveTokens(userId, fresh);
      return fresh;
    }
    return tokens;
  }

  loadTokens(userId: number): MalToken | null {
    const row = this.db.select().from(malTokens).where(eq(malTokens.userId, userId)).get();
    if (!row) return null;
    return {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      expiresAt: row.expiresAt,
    };
  }

  saveTokens(userId: number, tokens: MalToken): void {
    const existing = this.db.select().from(malTokens).where(eq(malTokens.userId, userId)).get();
    if (existing) {
      this.db
        .update(malTokens)
        .set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          updatedAt: this.now(),
        })
        .where(eq(malTokens.id, existing.id))
        .run();
      return;
    }
    this.db
      .insert(malTokens)
      .values({
        userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        updatedAt: this.now(),
      })
      .run();
  }
}
