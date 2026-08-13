import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons } from "../db/schema";
import type { JellyfinWebhookPayload } from "../integrations/types";
import { completeEpisode } from "./episode-service";

const TICKS_PER_SECOND = 10_000_000;
const PROGRESS_THROTTLE_MS = 15_000;
const COMPLETION_RATIO = 0.95;
const DISCARD_RATIO = 0.05;

export interface WebhookThrottleStore {
  get(episodeId: number): { time: number; position: number } | undefined;
  set(episodeId: number, entry: { time: number; position: number }): void;
  delete(episodeId: number): void;
}

const defaultThrottleStore: WebhookThrottleStore = new Map<number, { time: number; position: number }>();

export class WebhookService {
  constructor(
    private readonly db: Db,
    private readonly config: {
      webhookSecret: string;
      jellyfinUserId: string;
      defaultUserId: number;
    },
    private readonly now: () => number = Date.now,
    private readonly throttleStore: WebhookThrottleStore = defaultThrottleStore,
  ) {}

  validateSecret(secret: string | null): boolean {
    return Boolean(secret) && this.config.webhookSecret !== "" && secret === this.config.webhookSecret;
  }

  handleEvent(payload: JellyfinWebhookPayload): {
    completedEpisodeIds: number[];
    statusChangedAnimeIds: number[];
  } {
    if (
      this.config.jellyfinUserId &&
      payload.UserId &&
      payload.UserId !== this.config.jellyfinUserId
    ) {
      return { completedEpisodeIds: [], statusChangedAnimeIds: [] };
    }
    switch (payload.NotificationType) {
      case "ItemAdded":
        this.handleItemAdded(payload);
        return { completedEpisodeIds: [], statusChangedAnimeIds: [] };
      case "PlaybackStart":
        return { completedEpisodeIds: [], statusChangedAnimeIds: this.handlePlaybackStart(payload) };
      case "PlaybackProgress":
        this.handlePlaybackProgress(payload);
        return { completedEpisodeIds: [], statusChangedAnimeIds: [] };
      case "PlaybackStop":
        return { ...this.handlePlaybackStop(payload), statusChangedAnimeIds: [] };
      default:
        return { completedEpisodeIds: [], statusChangedAnimeIds: [] };
    }
  }

  private handleItemAdded(payload: JellyfinWebhookPayload): void {
    if (!payload.ItemId || payload.ItemType !== "Episode") return;
    this.db
      .update(episodes)
      .set({ available: true })
      .where(eq(episodes.jellyfinItemId, payload.ItemId))
      .run();
  }

  private handlePlaybackStart(payload: JellyfinWebhookPayload): number[] {
    const episode = this.findEpisodeByItemId(payload.ItemId);
    if (!episode) return [];
    this.throttleStore.delete(episode.id);

    const season = this.db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
    if (!season) return [];
    const anime = this.db.select().from(animes).where(eq(animes.id, season.animeId)).get();
    if (!anime || anime.status === "completed") return [];
    this.db
      .update(animes)
      .set({ status: "watching", lastWatchedAt: this.now(), updatedAt: this.now() })
      .where(eq(animes.id, anime.id))
      .run();
    return [anime.id];
  }

  private handlePlaybackProgress(payload: JellyfinWebhookPayload): void {
    const episode = this.findEpisodeByItemId(payload.ItemId);
    if (!episode || episode.watched) return;

    const position = this.ticksToSeconds(payload.PlaybackPositionTicks ?? 0);
    const runtime = this.runtimeSeconds(payload, episode);
    const last = this.throttleStore.get(episode.id);
    if (last) {
      const elapsed = this.now() - last.time;
      const delta = Math.abs(position - last.position);
      const maxDelta = runtime == null ? Number.POSITIVE_INFINITY : runtime * DISCARD_RATIO;
      if (elapsed < PROGRESS_THROTTLE_MS && delta <= maxDelta) return;
    }

    this.updateProgress(episode.id, position, payload);
    this.throttleStore.set(episode.id, { time: this.now(), position });
  }

  private handlePlaybackStop(payload: JellyfinWebhookPayload): { completedEpisodeIds: number[] } {
    const episode = this.findEpisodeByItemId(payload.ItemId);
    if (!episode) return { completedEpisodeIds: [] };

    const position = this.ticksToSeconds(payload.PlaybackPositionTicks ?? 0);
    const runtime = this.runtimeSeconds(payload, episode);
    const completed =
      payload.PlayedToCompletion === true ||
      (runtime != null && position >= Math.floor(runtime * COMPLETION_RATIO));

    if (completed) {
      completeEpisode(this.db, {
        episodeId: episode.id,
        userId: this.config.defaultUserId,
        positionSeconds: position,
        durationSeconds: payload.RunTimeTicks ? this.ticksToSeconds(payload.RunTimeTicks) : undefined,
        now: this.now,
      });
    } else if (runtime == null || position >= Math.floor(runtime * DISCARD_RATIO)) {
      this.updateProgress(episode.id, position, payload);
    }

    this.throttleStore.delete(episode.id);
    return completed ? { completedEpisodeIds: [episode.id] } : { completedEpisodeIds: [] };
  }

  private findEpisodeByItemId(itemId: string | undefined): typeof episodes.$inferSelect | undefined {
    if (!itemId) return undefined;
    return this.db
      .select()
      .from(episodes)
      .where(eq(episodes.jellyfinItemId, itemId))
      .get();
  }

  private runtimeSeconds(payload: JellyfinWebhookPayload, episode: typeof episodes.$inferSelect): number | null {
    if (payload.RunTimeTicks) return this.ticksToSeconds(payload.RunTimeTicks);
    return episode.durationSeconds;
  }

  private ticksToSeconds(ticks: number): number {
    return Math.floor(ticks / TICKS_PER_SECOND);
  }

  private updateProgress(
    episodeId: number,
    progressSeconds: number,
    payload: JellyfinWebhookPayload,
  ): void {
    const changes: Partial<typeof episodes.$inferInsert> = { progressSeconds };
    if (payload.RunTimeTicks) {
      changes.durationSeconds = this.ticksToSeconds(payload.RunTimeTicks);
    }
    this.db.update(episodes).set(changes).where(eq(episodes.id, episodeId)).run();
  }
}
