import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { AddToLibraryService, SonarrAddFailedError } from "@/lib/services/add-to-library-service";
import { SonarrImportService } from "@/lib/services/sonarr-import-service";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  const service = new AddToLibraryService(db, config, sonarr);

  const body = (await request.json()) as {
    item: Parameters<typeof service.addToLibrary>[0];
    candidate: Parameters<typeof service.addToLibrary>[1];
    monitor?: Parameters<typeof service.addToLibrary>[2];
  };

  try {
    const { sonarrId } = await service.addToLibrary(body.item, body.candidate, body.monitor);

    // Heal: if this anime's files are already downloaded (e.g. a re-add after a
    // reset), import them immediately instead of waiting for a manual sync.
    // Sonarr's folder scan bypasses its stale tracked-download cache.
    let importsTriggered = 0;
    try {
      const importService = new SonarrImportService(sonarr);
      const pending = await importService.findPendingImports(config.sonarrRootFolder, sonarrId);
      importsTriggered = await importService.importFiles(pending);
    } catch {
      // Heal is best-effort; the library sync (and the Downloads view) retry.
    }

    return NextResponse.json({ ok: true, importsTriggered });
  } catch (error) {
    if (error instanceof SonarrAddFailedError) {
      return NextResponse.json({ error: "sonarr_add_failed" }, { status: 502 });
    }
    throw error;
  }
}
