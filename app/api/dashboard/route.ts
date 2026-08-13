import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { DashboardService } from "@/lib/services/dashboard-service";
import { AniListHttpClient } from "@/lib/integrations/anilist-client";

export async function GET() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const service = new DashboardService(db, { jellyfinUrl: config.jellyfinUrl });

  const [continueWatching, watching, upcoming] = await Promise.all([
    service.getContinueWatching(),
    service.getWatching(),
    service.getUpcoming(12, Date.now(), new AniListHttpClient()),
  ]);

  return NextResponse.json({ continueWatching, watching, upcoming });
}
