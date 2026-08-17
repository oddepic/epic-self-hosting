import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";

import { UserService } from "@/lib/services/user-service";
import { LibraryService } from "@/lib/services/library-service";
import { createMalSync } from "@/lib/services/mal-sync-service";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const service = new LibraryService(db);

  const body = (await request.json()) as { animeId?: number; score?: unknown };
  if (!body.animeId || typeof body.score !== "number" || !Number.isFinite(body.score)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const score = Math.round(body.score);
  if (score < 0 || score > 10) {
    return NextResponse.json({ error: "invalid_score" }, { status: 400 });
  }

  service.setScore(body.animeId, score);

  const user = await new UserService(db, config).ensureConfiguredUser();
  void createMalSync(db, config).pushStatus(user.id, body.animeId);

  return NextResponse.json({ ok: true });
}
