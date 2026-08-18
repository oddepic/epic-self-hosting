import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { animes, episodes, seasons } from "@/lib/db/schema";
import { UserService } from "@/lib/services/user-service";
import { setWatchedThrough } from "@/lib/services/episode-service";
import { createMalSync } from "@/lib/services/mal-sync-service";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  const body = (await request.json()) as {
    episodeId?: number;
    animeId?: number;
    watchedEpisodes?: unknown;
  };
  if (body.episodeId == null && body.animeId == null) {
    return NextResponse.json({ error: "episodeId or animeId required" }, { status: 400 });
  }

  let animeId = body.animeId ?? null;
  if (body.episodeId != null) {
    const episode = db.select().from(episodes).where(eq(episodes.id, body.episodeId)).get();
    if (!episode) {
      return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
    }
    const season = db.select().from(seasons).where(eq(seasons.id, episode.seasonId)).get();
    animeId = season?.animeId ?? animeId;
    if (animeId == null) {
      return NextResponse.json({ error: "anime_not_found" }, { status: 404 });
    }
  }
  if (animeId == null) {
    return NextResponse.json({ error: "anime_not_found" }, { status: 404 });
  }

  const user = await new UserService(db, config).ensureConfiguredUser();

  // Sync the season's watched flags when a concrete episode is given (the
  // modal's per-season checkmarks), then set the entry-level counter.
  let marked = 0;
  let unmarked = 0;
  if (body.episodeId != null) {
    const result = setWatchedThrough(db, {
      episodeId: body.episodeId,
      userId: user.id,
      now: Date.now,
    });
    marked = result.marked;
    unmarked = result.unmarked;
  }

  if (typeof body.watchedEpisodes === "number" && Number.isFinite(body.watchedEpisodes)) {
    const next = Math.max(0, Math.round(body.watchedEpisodes));
    db.update(animes).set({ watchedEpisodes: next, updatedAt: Date.now() }).where(eq(animes.id, animeId)).run();
  }

  if (body.episodeId != null) {
    void createMalSync(db, config).pushEpisodeCompletion(user.id, body.episodeId);
  } else {
    void createMalSync(db, config).pushStatus(user.id, animeId);
  }

  return NextResponse.json({ ok: true, marked, unmarked });
}
