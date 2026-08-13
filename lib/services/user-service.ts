import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users, type User } from "../db/schema";
import type { AppConfig } from "../config";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, derived] = stored.split(":");
  if (!salt || !derived) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(derived, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export class UserService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  async ensureConfiguredUser(): Promise<User> {
    const existing = this.db
      .select()
      .from(users)
      .where(eq(users.username, this.config.userName))
      .get();
    if (existing) return existing;

    const now = Date.now();
    const created = this.db
      .insert(users)
      .values({
        username: this.config.userName,
        passwordHash: hashPassword(this.config.authPassword),
        preferences: {},
        createdAt: now,
      })
      .returning()
      .get();
    return created;
  }
}
