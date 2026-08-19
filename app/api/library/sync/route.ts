import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { reconcileAvailability } from "@/lib/services/availability-reconciliation-service";
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

    const result = await reconcileAvailability(db, jellyfin, sonarr, { rescanSonarr: true });

    publish("availability-updated", { reason: "library-sync" });

    return NextResponse.json({
      ...result,
      importsTriggered,
    });
  } catch (error) {
    console.error("library sync failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "sync_failed" },
      { status: 500 },
    );
  }
}
