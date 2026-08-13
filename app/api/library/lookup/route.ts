import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { AddToLibraryService } from "@/lib/services/add-to-library-service";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  const service = new AddToLibraryService(db, config, sonarr);

  const body = (await request.json()) as { item: unknown };
  const item = body.item as Parameters<typeof service.resolveBestMatch>[0];
  const result = await service.resolveBestMatch(item);
  if (result.matched) {
    return NextResponse.json({ matched: true, candidate: result.candidate, monitor: result.monitor });
  }
  return NextResponse.json({ matched: false, candidates: result.candidates });
}
