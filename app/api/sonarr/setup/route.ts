import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { SonarrProfileService } from "@/lib/services/sonarr-profile-service";

export async function POST() {
  const config = loadConfig();
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  const service = new SonarrProfileService();
  const profile = await service.verifyProfile(sonarr, config.sonarrQualityProfileId);
  return NextResponse.json({ profile });
}
