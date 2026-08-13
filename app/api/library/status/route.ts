import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";

import { UserService } from "@/lib/services/user-service";
import { LibraryService, type AnimeStatus } from "@/lib/services/library-service";
import { createMalSync } from "@/lib/services/mal-sync-service";

const VALID_STATUSES = new Set<AnimeStatus>(["watching", "completed", "plan_to_watch", "on_hold", "dropped"]);

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const service = new LibraryService(db);

  const body = (await request.json()) as { animeId?: number; status?: string };
  if (!body.animeId || !body.status || !VALID_STATUSES.has(body.status as AnimeStatus)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  service.setStatus(body.animeId, body.status as AnimeStatus);

  const user = await new UserService(db, config).ensureConfiguredUser();
  void createMalSync(db, config).pushStatus(user.id, body.animeId);

  return NextResponse.json({ ok: true });
}

