import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { DownloadStatusService } from "@/lib/services/download-status-service";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";

export async function GET() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  const service = new DownloadStatusService(db, sonarr);

  const items = await service.getDownloadStatus();
  return NextResponse.json({ items });
}
