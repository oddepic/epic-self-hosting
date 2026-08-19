import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { JellyfinSdkClient } from "@/lib/integrations/jellyfin-client";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { reconcileAvailability, waitForJellyfinLibraryScan } from "@/lib/services/availability-reconciliation-service";
import { createDb } from "@/lib/db/client";
import { publish } from "@/lib/events/bus";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  if (!config.jellyfinUrl || !config.jellyfinApiKey) {
    return NextResponse.json({ error: "Jellyfin not configured" }, { status: 503 });
  }

  const secret = request.headers.get("X-Refresh-Secret");
  if (config.jellyfinRefreshSecret && secret !== config.jellyfinRefreshSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const jellyfin = new JellyfinSdkClient(
    config.jellyfinUrl,
    config.jellyfinApiKey,
    { name: "epic self-hosting", version: "0.1.0" },
    { name: "server", id: "epic-self-hosting-refresh" },
  );

  try {
    await jellyfin.refreshLibrary();
    await waitForJellyfinLibraryScan(jellyfin);
    const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
    const result = await reconcileAvailability(db, jellyfin, sonarr);
    publish("availability-updated", { reason: "jellyfin-refresh" });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("jellyfin refresh failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "refresh_failed" },
      { status: 500 },
    );
  }
}
