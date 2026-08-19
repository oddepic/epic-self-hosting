import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { AvailabilityService } from "@/lib/services/availability-service";
import { SonarrImportService } from "@/lib/services/sonarr-import-service";
import { JellyfinSdkClient } from "@/lib/integrations/jellyfin-client";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { publish } from "@/lib/events/bus";

async function waitForLibraryScan(jellyfin: JellyfinSdkClient): Promise<void> {
  // RefreshLibrary starts asynchronously. Give Jellyfin time to transition
  // the task to Running, then wait until it returns to Idle (max 60s).
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!(await jellyfin.isLibraryScanRunning())) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

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
    const pendingEpisodeIds = new Set(pending.flatMap((item) => item.episodeIds));
    const missingEpisodeIds = (await sonarr.getMissingMonitoredEpisodeIds()).filter(
      (episodeId) => !pendingEpisodeIds.has(episodeId),
    );
    const missingSearchTriggered = missingEpisodeIds.length > 0;
    if (missingSearchTriggered) {
      // Explicit episode IDs only. Never use SeriesSearch/SeasonSearch here:
      // the refresh button must not re-search an entire anime accidentally.
      await sonarr.searchEpisodes(missingEpisodeIds);
    }

    const service = new AvailabilityService(db, jellyfin, sonarr);
    let result = await service.sync();
    let rescanTriggered = false;

    // Jellyfin's index is stale when Sonarr has files the app can't see —
    // rescan Jellyfin once and retry before giving up (e.g. a file Jellyfin
    // skipped during an earlier scan).
    if (result.missingFromJellyfin > 0) {
      try {
        await jellyfin.refreshLibrary();
        await waitForLibraryScan(jellyfin);
        result = await service.sync();
        rescanTriggered = true;
      } catch {
        // Keep the first result; a later sync retries.
      }
    }

    publish("availability-updated", { reason: "library-sync" });

    return NextResponse.json({
      ...result,
      importsTriggered,
      missingSearchTriggered,
      missingSearchCount: missingEpisodeIds.length,
      rescanTriggered,
    });
  } catch (error) {
    console.error("library sync failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "sync_failed" },
      { status: 500 },
    );
  }
}
