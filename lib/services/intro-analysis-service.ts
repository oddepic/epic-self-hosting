import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { animes, episodes, seasons } from "../db/schema";
import type { JellyfinClient } from "../integrations/types";

// How long to wait before triggering analysis again. A batch download fires
// one ItemAdded per episode; the first trigger runs the plugin's analysis
// task (which covers the whole queue), so the rest land inside the cooldown.
const SCAN_COOLDOWN_MS = 10 * 60 * 1000;

// Module-level so the cooldown survives across requests (the service is
// rebuilt per webhook POST). Resets when the app process restarts, which
// only re-allows one extra bounded run.
const lastRunAt = new Map<string, number>();

/**
 * App-driven Intro Skipper analysis.
 *
 * The plugin's own automatic analysis task re-analyzed the library endlessly
 * (an invalid-SeasonId loop) and crashed Jellyfin 10.11.11 with native stack
 * overflows (0xc00000fd) four times in one day. Its automatic trigger is
 * disabled; instead the app runs the SAME task once when a newly added
 * episode has no intro/credits segments yet.
 */
export class IntroAnalysisService {
  constructor(
    private readonly db: Db,
    private readonly jellyfin: JellyfinClient,
    private readonly segmentsToken: string,
    private readonly options: { cooldownMs?: number; now?: () => number } = {},
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  /**
   * Called when Jellyfin reports a new episode (ItemAdded webhook). Returns
   * true when the analysis task was actually started.
   */
  async maybeTriggerForEpisode(itemId: string): Promise<boolean> {
    const episode = this.db.select().from(episodes).where(eq(episodes.jellyfinItemId, itemId)).get();
    if (!episode) return false;
    const season = this.db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
    if (!season) return false;
    const anime = this.db.select().from(animes).where(eq(animes.id, season.animeId)).get();
    if (!anime?.jellyfinId) return false;

    const cooldownMs = this.options.cooldownMs ?? SCAN_COOLDOWN_MS;
    const key = `${anime.jellyfinId}:${season.number}`;
    const last = lastRunAt.get(key);
    if (last != null && this.now() - last < cooldownMs) return false;

    try {
      // Already analyzed episodes keep their segments — no need to re-scan.
      const segments = await this.jellyfin.getIntroSkipperSegments(itemId, this.segmentsToken);
      if (segments.intro != null || segments.credits != null) return false;

      if (await this.jellyfin.getIntroScanStatus()) return false;

      const taskId = await this.jellyfin.getIntroAnalysisTaskId();
      if (!taskId) return false;

      const started = await this.jellyfin.runScheduledTask(taskId);
      if (started) {
        lastRunAt.set(key, this.now());
      }
      return started;
    } catch {
      // Analysis is advisory; never surface errors to the webhook flow.
      return false;
    }
  }
}
