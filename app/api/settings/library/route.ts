import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { LibrarySettingsService } from "@/lib/services/library-settings-service";
import { UserService } from "@/lib/services/user-service";

export async function GET() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();
  return NextResponse.json(new LibrarySettingsService(db).getSettings(user.id));
}

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();
  const service = new LibrarySettingsService(db);

  const body = (await request.json()) as { showSpecials?: unknown };
  const current = service.getSettings(user.id);
  const next = {
    showSpecials: typeof body.showSpecials === "boolean" ? body.showSpecials : current.showSpecials,
  };

  return NextResponse.json(service.saveSettings(user.id, next));
}
