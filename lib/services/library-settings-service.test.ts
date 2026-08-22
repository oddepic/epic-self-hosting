import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client";
import { users } from "../db/schema";
import { hashPassword } from "./user-service";
import { DEFAULT_LIBRARY_SETTINGS, LibrarySettingsService } from "./library-settings-service";

describe("LibrarySettingsService", () => {
  let db: Db;
  let service: LibrarySettingsService;
  let userId: number;

  beforeEach(() => {
    db = createDb(":memory:");
    service = new LibrarySettingsService(db);
    userId = db
      .insert(users)
      .values({ username: "admin", passwordHash: hashPassword("x"), preferences: {}, createdAt: 1 })
      .returning()
      .get().id;
  });

  it("returns defaults when nothing is saved", () => {
    expect(service.getSettings(userId)).toEqual(DEFAULT_LIBRARY_SETTINGS);
  });

  it("saves and reloads settings", () => {
    service.saveSettings(userId, { showSpecials: true });
    expect(service.getSettings(userId)).toEqual({ showSpecials: true });
  });

  it("preserves other preference fields when saving library settings", () => {
    db.update(users).set({ preferences: { theme: "dark" } }).where(eq(users.id, userId)).run();
    service.saveSettings(userId, { showSpecials: true });
    const row = db.select().from(users).where(eq(users.id, userId)).get();
    expect(row!.preferences).toEqual({
      theme: "dark",
      library: { showSpecials: true },
    });
  });

  it("falls back to defaults for malformed stored values", () => {
    db.update(users)
      .set({ preferences: { library: { showSpecials: "yes" } } })
      .where(eq(users.id, userId))
      .run();
    expect(service.getSettings(userId)).toEqual(DEFAULT_LIBRARY_SETTINGS);
  });
});
