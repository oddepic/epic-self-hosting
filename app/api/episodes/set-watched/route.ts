import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { episodes } from "@/lib/db/schema";
import { UserService } from "@/lib/services/user-service";
import { setWatchedThrough } from "@/lib/services/episode-service";
import { createMalSync } from "@/lib/services/mal-sync-service";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  const body = (await request.json()) as { episodeId?: number };
  if (!body.episodeId) {
    return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  }

  const episode = db.select().from(episodes).where(eq(episodes.id, body.episodeId)).get();
  if (!episode) {
    return NextResponse.json({ error: "episode_not_found" }, { status: 404 });
  }

  const user = await new UserService(db, config).ensureConfiguredUser();

  const result = setWatchedThrough(db, {
    episodeId: episode.id,
    userId: user.id,
    now: Date.now,
  });

  void createMalSync(db, config).pushEpisodeCompletion(user.id, episode.id);

  return NextResponse.json({ ok: true, ...result });
}
