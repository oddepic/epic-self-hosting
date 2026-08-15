import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { DEFAULT_PREFERENCE, TrackPreferenceService } from "@/lib/services/track-preference-service";
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

  const existing = service.getPreference(user.id);
  service.savePreference(user.id, {
    audioLanguage:
      body.audioLanguage !== undefined
        ? body.audioLanguage
        : (existing?.audioLanguage ?? DEFAULT_PREFERENCE.audioLanguage),
    subtitleLanguage:
      body.subtitleLanguage !== undefined
        ? body.subtitleLanguage
        : (existing?.subtitleLanguage ?? DEFAULT_PREFERENCE.subtitleLanguage),
    subtitleForced:
      body.subtitleForced !== undefined
        ? body.subtitleForced
        : (existing?.subtitleForced ?? DEFAULT_PREFERENCE.subtitleForced),
  });
  return NextResponse.json({ ok: true });
}
