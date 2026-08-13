import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type Db } from "../db/client";
import { users } from "../db/schema";
import { UserService } from "./user-service";
import type { AppConfig } from "../config";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serverName: "Test Server",
    userName: "admin",
    authPassword: "correct-horse-battery-staple",
    databaseUrl: ":memory:",
    jellyfinUrl: "http://localhost:8096",
    jellyfinApiKey: "jf-key",
    jellyfinUserId: "jf-user",
    jellyfinWebhookSecret: "secret",
    jellyfinRefreshSecret: "",
    jellyfinServiceUsername: "epic",
    jellyfinServicePassword: "secret",
    sonarrUrl: "http://localhost:8989",
    sonarrApiKey: "sonarr-key",
    sonarrRootFolder: "D:\\Downloads\\Anime",
    sonarrQualityProfileId: 4,
    malClientId: "",
    malClientSecret: "",
    ...overrides,
  };
}

describe("UserService.ensureConfiguredUser", () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("creates the configured user on first call", async () => {
    const service = new UserService(db, testConfig());
    const user = await service.ensureConfiguredUser();
    const rows = db.select().from(users).all();
    expect(user.username).toBe("admin");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.passwordHash).not.toBe("correct-horse-battery-staple");
  });

  it("is idempotent — a second call does not duplicate the user", async () => {
    const service = new UserService(db, testConfig());
    await service.ensureConfiguredUser();
    const user = await service.ensureConfiguredUser();
    const rows = db.select().from(users).all();
    expect(user.id).toBe(rows[0]!.id);
    expect(rows).toHaveLength(1);
  });

  it("does not overwrite an existing user with a different password", async () => {
    const service = new UserService(db, testConfig());
    const original = await service.ensureConfiguredUser();
    const recreated = new UserService(db, testConfig({ authPassword: "new-password" }));
    const user = await recreated.ensureConfiguredUser();
    expect(user.id).toBe(original.id);
    expect(user.passwordHash).toBe(original.passwordHash);
  });
});

