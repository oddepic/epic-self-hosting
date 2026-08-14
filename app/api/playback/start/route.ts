import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { PlaybackService, EpisodeNotAvailableError } from "@/lib/services/playback-service";
import { UserService } from "@/lib/services/user-service";
import { JellyfinSdkClient } from "@/lib/integrations/jellyfin-client";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const jellyfin = new JellyfinSdkClient(
    config.jellyfinUrl,
    config.jellyfinApiKey,
    { name: "Epic Self-Hosted", version: "0.1.0" },
    { name: "browser", id: "epic-self-hosted-web" },
  );
  const service = new PlaybackService(db, jellyfin, {
    jellyfinUrl: config.jellyfinUrl,
    serviceUsername: config.jellyfinServiceUsername,
    servicePassword: config.jellyfinServicePassword,
  });

  const body = (await request.json()) as {
    episodeId?: number;
    resume?: boolean;
    audioStreamIndex?: number;
  };
  if (!body.episodeId) {
    return NextResponse.json({ error: "episodeId required" }, { status: 400 });
  }
  if (!config.jellyfinServiceUsername || !config.jellyfinServicePassword) {
    return NextResponse.json(
      { error: "JELLYFIN_SERVICE_USERNAME / JELLYFIN_SERVICE_PASSWORD not configured" },
      { status: 503 },
    );
  }

  try {
    const user = await new UserService(db, config).ensureConfiguredUser();
    const result = await service.startPlayback(body.episodeId, {
      resume: body.resume !== false,
      userId: user.id,
      audioStreamIndex: body.audioStreamIndex,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EpisodeNotAvailableError) {
      return NextResponse.json({ error: "episode_not_available" }, { status: 404 });
    }
    console.error("playback start failed:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "playback_start_failed",
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 },
    );
  }
}
