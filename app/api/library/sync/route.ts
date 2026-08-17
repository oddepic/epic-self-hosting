import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { AvailabilityService } from "@/lib/services/availability-service";
import { SonarrImportService } from "@/lib/services/sonarr-import-service";
import { JellyfinSdkClient } from "@/lib/integrations/jellyfin-client";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { publish } from "@/lib/events/bus";

export async function POST() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const jellyfin = new JellyfinSdkClient(
    config.jellyfinUrl,
    config.jellyfinApiKey,
    { name: "epic self-hosting", version: "0.1.0" },
    { name: "server", id: "epic-self-hosting-server" },
  );
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);

  try {
    const importService = new SonarrImportService(sonarr);
    const pending = await importService.findPendingImports(config.sonarrRootFolder);
    const importsTriggered = await importService.importFiles(pending);

    const service = new AvailabilityService(db, jellyfin, sonarr);
    let result = await service.sync();
    let rescanTriggered = false;

    // Jellyfin's index is stale when Sonarr has files the app can't see —
    // rescan Jellyfin once and retry before giving up (e.g. a file Jellyfin
    // skipped during an earlier scan).
    if (result.missingFromJellyfin > 0) {
      try {
        await jellyfin.refreshLibrary();
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        result = await service.sync();
        rescanTriggered = true;
      } catch {
        // Keep the first result; a later sync retries.
      }
    }

    publish("availability-updated", { reason: "library-sync" });

    return NextResponse.json({ ...result, importsTriggered, rescanTriggered });
  } catch (error) {
    console.error("library sync failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "sync_failed" },
      { status: 500 },
    );
  }
}
