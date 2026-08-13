import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { UserService } from "@/lib/services/user-service";
import { createMalImport } from "@/lib/services/mal-sync-service";

export async function GET() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();

  const importService = createMalImport(db, config);
  const tokens = importService.loadTokens(user.id);

  return NextResponse.json({ linked: Boolean(tokens) });
}
