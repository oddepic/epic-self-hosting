import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { users } from "../db/schema";
import { hashPassword } from "./user-service";
import { DEFAULT_PLAYBACK_SETTINGS, PlaybackSettingsService } from "./playback-settings-service";

describe("PlaybackSettingsService", () => {
  let db: Db;
  let service: PlaybackSettingsService;
  let userId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new PlaybackSettingsService(db);
    userId = db
      .insert(users)
      .values({ username: "admin", passwordHash: hashPassword("x"), preferences: {}, createdAt: 1 })
      .returning()
      .get().id;
  });

  it("returns defaults when nothing is saved", () => {
    expect(service.getSettings(userId)).toEqual(DEFAULT_PLAYBACK_SETTINGS);
  });

  it("saves and reloads settings", () => {
    service.saveSettings(userId, { autoplayNext: false, skipSeconds: 10, volume: 0.4 });
    expect(service.getSettings(userId)).toEqual({ autoplayNext: false, skipSeconds: 10, volume: 0.4 });
  });

  it("preserves other preference fields when saving playback settings", () => {
    db.update(users).set({ preferences: { theme: "dark" } }).where(eq(users.id, userId)).run();
    service.saveSettings(userId, { autoplayNext: false, skipSeconds: 10, volume: 0.4 });
    const row = db.select().from(users).where(eq(users.id, userId)).get();
    expect(row!.preferences).toEqual({
      theme: "dark",
      playback: { autoplayNext: false, skipSeconds: 10, volume: 0.4 },
    });
  });

  it("falls back to defaults for malformed stored values", () => {
    db.update(users)
      .set({ preferences: { playback: { autoplayNext: "yes", skipSeconds: -3, volume: 7 } } })
      .where(eq(users.id, userId))
      .run();
    expect(service.getSettings(userId)).toEqual(DEFAULT_PLAYBACK_SETTINGS);
  });
});
