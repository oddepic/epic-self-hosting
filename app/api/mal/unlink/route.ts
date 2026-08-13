import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { UserService } from "@/lib/services/user-service";
import { createMalSync } from "@/lib/services/mal-sync-service";

export async function POST() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();

  createMalSync(db, config).unlink(user.id);

  return NextResponse.json({ ok: true });
}
