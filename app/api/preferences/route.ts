import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { TrackPreferenceService } from "@/lib/services/track-preference-service";
import { UserService } from "@/lib/services/user-service";

export async function GET() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();
  const service = new TrackPreferenceService(db);

  const pref = service.getPreference(user.id);
  return NextResponse.json({ preference: pref });
}

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();
  const service = new TrackPreferenceService(db);

  const body = (await request.json()) as {
    audioLanguage?: string | null;
    subtitleLanguage?: string | null;
    subtitleForced?: boolean;
  };

  service.savePreference(user.id, {
    audioLanguage: body.audioLanguage ?? null,
    subtitleLanguage: body.subtitleLanguage ?? null,
    subtitleForced: body.subtitleForced ?? false,
  });
  return NextResponse.json({ ok: true });
}
