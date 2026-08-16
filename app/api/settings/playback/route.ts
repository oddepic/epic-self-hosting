import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { PlaybackSettingsService } from "@/lib/services/playback-settings-service";
import { UserService } from "@/lib/services/user-service";

export async function GET() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();
  return NextResponse.json(new PlaybackSettingsService(db).getSettings(user.id));
}

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();
  const service = new PlaybackSettingsService(db);

  const body = (await request.json()) as { autoplayNext?: unknown; skipSeconds?: unknown; volume?: unknown };
  const current = service.getSettings(user.id);

  const next = {
    autoplayNext: typeof body.autoplayNext === "boolean" ? body.autoplayNext : current.autoplayNext,
    skipSeconds:
      typeof body.skipSeconds === "number" && Number.isFinite(body.skipSeconds) && body.skipSeconds >= 1 && body.skipSeconds <= 60
        ? body.skipSeconds
        : current.skipSeconds,
    volume:
      typeof body.volume === "number" && Number.isFinite(body.volume) && body.volume >= 0 && body.volume <= 1
        ? body.volume
        : current.volume,
  };

  return NextResponse.json(service.saveSettings(user.id, next));
}
