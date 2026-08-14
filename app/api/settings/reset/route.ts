import { NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { ResetService } from "@/lib/services/reset-service";
import { JellyfinSdkClient } from "@/lib/integrations/jellyfin-client";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";

export async function POST() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const jellyfin = new JellyfinSdkClient(
    config.jellyfinUrl,
    config.jellyfinApiKey,
    { name: "Epic Self-Hosted", version: "0.1.0" },
    { name: "server", id: "epic-self-hosted-reset" },
  );
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);

  const service = new ResetService(db, jellyfin, sonarr, config.sonarrRootFolder);
  try {
    const result = await service.reset();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("hard reset failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "reset_failed" },
      { status: 500 },
    );
  }
}
