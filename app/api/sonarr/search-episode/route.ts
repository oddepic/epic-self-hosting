import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadConfig } from "@/lib/config";
import { createDb } from "@/lib/db/client";
import { animes, episodes, seasons } from "@/lib/db/schema";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";

// Per-episode fetch for the franchise modal (Bug 06 Problem 5 follow-up):
// clicking an un-downloaded episode monitors and searches exactly that
// episode in Sonarr. Skips the search when Sonarr already has a file (stale
// Jellyfin availability) — monitoring alone lets the import flow recover it.
export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);

  const body = (await request.json()) as { episodeId?: number };
  if (!body.episodeId) {
    return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  }

  const episode = db.select().from(episodes).where(eq(episodes.id, body.episodeId)).get();
  if (!episode) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }
  const season = db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
  const anime = season
    ? db.select().from(animes).where(eq(animes.id, season.animeId)).get()
    : undefined;
  if (!season || !anime?.sonarrId) {
    return NextResponse.json({ error: "series_not_linked" }, { status: 400 });
  }

  try {
    const sonarrEpisodes = await sonarr.getEpisodes(anime.sonarrId);
    const match =
      sonarrEpisodes.find((e) => episode.sonarrEpisodeId != null && e.id === episode.sonarrEpisodeId) ??
      sonarrEpisodes.find(
        (e) => e.seasonNumber === season.number && e.episodeNumber === episode.episodeNumber,
      );
    if (!match) {
      return NextResponse.json({ error: "episode_not_in_sonarr" }, { status: 404 });
    }
    if (match.hasFile === true) {
      return NextResponse.json({ ok: true, alreadyInSonarr: true, sonarrEpisodeId: match.id });
    }
    // Explicit episode id only — never a season-wide or series-wide search.
    await sonarr.setEpisodesMonitored([match.id], true);
    await sonarr.searchEpisodes([match.id]);
    return NextResponse.json({ ok: true, sonarrEpisodeId: match.id, searched: 1 });
  } catch (error) {
    console.error("sonarr episode search failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "search_failed" },
      { status: 500 },
    );
  }
}
