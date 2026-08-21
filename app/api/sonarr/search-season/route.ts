import { NextRequest, NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";

// Per-season download for an added franchise (Bug 06 Problem 5): monitor the
// season's un-downloaded episodes, then episode-search exactly those ids.
// Works even when the season was never monitored — the Sonarr tab's Fix only
// covers monitored episodes.
export async function POST(request: NextRequest) {
  const config = loadConfig();
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);

  const body = (await request.json()) as { seriesId?: number; season?: number };
  if (!body.seriesId || body.season == null) {
    return NextResponse.json({ error: "seriesId and season required" }, { status: 400 });
  }

  try {
    const episodes = await sonarr.getEpisodes(body.seriesId);
    const targets = episodes
      .filter((e) => e.seasonNumber === body.season && e.hasFile !== true)
      .map((e) => e.id);
    if (targets.length > 0) {
      // Explicit episode ids only — never a series-wide search.
      await sonarr.setEpisodesMonitored(targets, true);
      await sonarr.searchEpisodes(targets);
    }
    return NextResponse.json({ ok: true, seriesId: body.seriesId, season: body.season, searched: targets.length });
  } catch (error) {
    console.error("sonarr season search failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "search_failed" },
      { status: 500 },
    );
  }
}
