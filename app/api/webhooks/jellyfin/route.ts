import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { UserService } from "@/lib/services/user-service";
import { WebhookService } from "@/lib/services/webhook-service";
import { IntroAnalysisService } from "@/lib/services/intro-analysis-service";
import { JellyfinSdkClient } from "@/lib/integrations/jellyfin-client";
import { SonarrHttpClient } from "@/lib/integrations/sonarr-client";
import { reconcileAvailability } from "@/lib/services/availability-reconciliation-service";
import { createMalSync } from "@/lib/services/mal-sync-service";
import { publish } from "@/lib/events/bus";
import type { JellyfinWebhookPayload } from "@/lib/integrations/types";

let availabilitySyncInFlight: Promise<void> | null = null;

function scheduleAvailabilitySync(config: ReturnType<typeof loadConfig>, db: ReturnType<typeof createDb>): void {
  if (availabilitySyncInFlight) return;
  const jellyfin = new JellyfinSdkClient(
    config.jellyfinUrl,
    config.jellyfinApiKey,
    { name: "epic self-hosting", version: "0.1.0" },
    { name: "server", id: "epic-self-hosting-item-added" },
  );
  const sonarr = new SonarrHttpClient(config.sonarrUrl, config.sonarrApiKey);
  availabilitySyncInFlight = reconcileAvailability(db, jellyfin, sonarr)
    .then(() => undefined)
    .catch((error) => {
      console.error("automatic availability sync failed:", error);
    })
    .finally(() => {
      availabilitySyncInFlight = null;
    });
}

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();
  const service = new WebhookService(db, {
    webhookSecret: config.jellyfinWebhookSecret,
    jellyfinUserId: config.jellyfinUserId,
    defaultUserId: user.id,
  });

  const secret = request.headers.get("X-Webhook-Secret");
  if (!service.validateSecret(secret)) {
    console.error("[webhook] rejected: bad secret");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: JellyfinWebhookPayload;
  try {
    payload = (await request.json()) as JellyfinWebhookPayload;
  } catch {
    console.error("[webhook] rejected: invalid JSON");
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { completedEpisodeIds, statusChangedAnimeIds } = service.handleEvent(payload);
  if (payload.NotificationType === "ItemAdded") {
    publish("availability-updated", { reason: "webhook-item-added" });
    // Jellyfin already knows about a newly indexed episode; reconcile now so
    // the app maps its season/episode row without waiting for Refresh.
    scheduleAvailabilitySync(config, db);
    // A newly downloaded episode: if it has no intro/credits segments yet,
    // run ONE bounded Intro Skipper scan of its season (the plugin's own
    // endless scheduled analysis was crashing Jellyfin and is disabled).
    if (payload.ItemType === "Episode" && payload.ItemId) {
      const jellyfin = new JellyfinSdkClient(
        config.jellyfinUrl,
        config.jellyfinApiKey,
        { name: "epic self-hosting", version: "0.1.0" },
        { name: "server", id: "epic-self-hosting-webhook" },
      );
      const introAnalysis = new IntroAnalysisService(db, jellyfin, config.jellyfinApiKey);
      void introAnalysis.maybeTriggerForEpisode(payload.ItemId).catch(() => {});
    }
  }
  const malSync = createMalSync(db, config);
  for (const animeId of statusChangedAnimeIds) {
    void malSync.pushStatus(user.id, animeId);
  }
  for (const episodeId of completedEpisodeIds) {
    void malSync.pushEpisodeCompletion(user.id, episodeId);
  }
  return NextResponse.json({ ok: true });
}
