import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { SonarrProfileService } from "@/lib/services/sonarr-profile-service";

export async function GET() {
  const config = loadConfig();
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  try {
    const limit = await new SonarrProfileService().getSizeLimit(sonarr);
    return NextResponse.json(limit);
  } catch (error) {
    console.error("get size limit failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "get_size_limit_failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const config = loadConfig();
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  try {
    const body = (await request.json()) as { maxGb?: unknown };
    const maxGb = typeof body.maxGb === "number" ? body.maxGb : NaN;
    if (!Number.isFinite(maxGb) || maxGb <= 0) {
      return NextResponse.json({ error: "maxGb must be a positive number in GB" }, { status: 400 });
    }
    const limit = await new SonarrProfileService().setSizeLimit(sonarr, maxGb);
    return NextResponse.json(limit);
  } catch (error) {
    console.error("set size limit failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "set_size_limit_failed" },
      { status: 500 },
    );
  }
}
