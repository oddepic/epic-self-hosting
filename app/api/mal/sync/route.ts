import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { UserService } from "@/lib/services/user-service";
import { createMalImport } from "@/lib/services/mal-sync-service";

export async function POST() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();

  const importService = createMalImport(db, config);
  const tokens = importService.loadTokens(user.id);
  if (!tokens) {
    return NextResponse.json({ linked: false, result: null });
  }

  const result = await importService.importList(user.id, tokens);
  return NextResponse.json({ linked: true, result });
}
