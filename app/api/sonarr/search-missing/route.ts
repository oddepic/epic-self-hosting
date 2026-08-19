import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);

  const body = (await request.json()) as { seriesId?: number };
  if (!body.seriesId) {
    return NextResponse.json({ error: "seriesId required" }, { status: 400 });
  }

  try {
    const missingBySeries = await sonarr.getMissingMonitoredBySeries();
    const episodeIds = missingBySeries.find((entry) => entry.seriesId === body.seriesId)?.episodeIds ?? [];
    if (episodeIds.length > 0) {
      // Explicit episode IDs only — never a series-wide or season-wide search.
      await sonarr.searchEpisodes(episodeIds);
    }
    return NextResponse.json({ ok: true, seriesId: body.seriesId, searched: episodeIds.length });
  } catch (error) {
    console.error("sonarr missing-episode search failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "search_failed" },
      { status: 500 },
    );
  }
}
