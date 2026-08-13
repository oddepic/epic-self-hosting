import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { UserService } from "@/lib/services/user-service";
import { WebhookService } from "@/lib/services/webhook-service";
import { createMalSync } from "@/lib/services/mal-sync-service";
import { publish } from "@/lib/events/bus";
import type { JellyfinWebhookPayload } from "@/lib/integrations/types";

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

  console.error(
    "[webhook]",
    payload.NotificationType,
    "userId=" + payload.UserId,
    "itemId=" + payload.ItemId,
    "position=" + payload.PlaybackPositionTicks,
    "completed=" + payload.PlayedToCompletion,
  );
  const { completedEpisodeIds, statusChangedAnimeIds } = service.handleEvent(payload);
  if (payload.NotificationType === "ItemAdded") {
    publish("availability-updated", { reason: "webhook-item-added" });
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
