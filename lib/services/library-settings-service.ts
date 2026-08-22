import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";

export interface LibrarySettings {
  showSpecials: boolean;
}

export const DEFAULT_LIBRARY_SETTINGS: LibrarySettings = {
  showSpecials: false,
};

export class LibrarySettingsService {
  constructor(private readonly db: Db) {}

  getSettings(userId: number): LibrarySettings {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    return LibrarySettingsService.fromPreferences(row?.preferences);
  }

  saveSettings(userId: number, settings: LibrarySettings): LibrarySettings {
    const row = this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new Error("user not found");
    this.db
      .update(users)
      .set({ preferences: { ...(row.preferences ?? {}), library: settings } })
      .where(eq(users.id, userId))
      .run();
    return settings;
  }

  static fromPreferences(preferences: Record<string, unknown> | null | undefined): LibrarySettings {
    const raw = preferences?.library;
    const p = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      showSpecials:
        typeof p.showSpecials === "boolean" ? p.showSpecials : DEFAULT_LIBRARY_SETTINGS.showSpecials,
    };
  }
}
