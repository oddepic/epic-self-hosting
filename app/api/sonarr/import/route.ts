import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { SonarrImportService } from "@/lib/services/sonarr-import-service";

export async function GET() {
  const config = loadConfig();
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  try {
    const service = new SonarrImportService(sonarr);
    const items = await service.findPendingImports(config.sonarrRootFolder);
    return NextResponse.json({ items });
  } catch (error) {
    console.error("get pending imports failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "get_pending_imports_failed" },
      { status: 500 },
    );
  }
}

export async function POST() {
  const config = loadConfig();
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  try {
    const service = new SonarrImportService(sonarr);
    const pending = await service.findPendingImports(config.sonarrRootFolder);
    const imported = await service.importFiles(pending);
    return NextResponse.json({ imported });
  } catch (error) {
    console.error("import pending files failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "import_pending_files_failed" },
      { status: 500 },
    );
  }
}
