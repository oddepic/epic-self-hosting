import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { SonarrDashboardService } from "@/lib/services/sonarr-dashboard-service";

export async function GET() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  const service = new SonarrDashboardService(db, sonarr, { rootFolder: config.sonarrRootFolder });

  const [overview, library] = await Promise.all([service.getOverview(), service.getLibrary()]);
  return NextResponse.json({ overview, library });
}
