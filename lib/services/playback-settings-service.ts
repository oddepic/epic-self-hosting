import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";

export interface PlaybackSettings {
  autoplayNext: boolean;
  skipSeconds: number;
}

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  autoplayNext: true,
  skipSeconds: 5,
};

export class PlaybackSettingsService {
  constructor(private readonly db: Db) {}

  getSettings(userId: number): PlaybackSettings {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    return PlaybackSettingsService.fromPreferences(row?.preferences);
  }

  saveSettings(userId: number, settings: PlaybackSettings): PlaybackSettings {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new Error("user not found");
    this.db
      .update(users)
      .set({ preferences: { ...(row.preferences ?? {}), playback: settings } })
      .where(eq(users.id, userId))
      .run();
    return settings;
  }

  static fromPreferences(preferences: Record<string, unknown> | null | undefined): PlaybackSettings {
    const raw = preferences?.playback;
    const p = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      autoplayNext:
        typeof p.autoplayNext === "boolean" ? p.autoplayNext : DEFAULT_PLAYBACK_SETTINGS.autoplayNext,
      skipSeconds:
        typeof p.skipSeconds === "number" && Number.isFinite(p.skipSeconds) && p.skipSeconds > 0
          ? p.skipSeconds
          : DEFAULT_PLAYBACK_SETTINGS.skipSeconds,
    };
  }
}
