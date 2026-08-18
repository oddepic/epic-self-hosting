import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { UserService } from "@/lib/services/user-service";
import { createMalImport } from "@/lib/services/mal-sync-service";

export async function POST(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const body = (await request.json()) as { animeId?: number };
  if (!body.animeId) {
    return NextResponse.json({ error: "animeId required" }, { status: 400 });
  }

  try {
    const user = await new UserService(db, config).ensureConfiguredUser();
    const synced = await createMalImport(db, config).syncAnime(user.id, body.animeId);
    return NextResponse.json({ ok: true, synced });
  } catch {
    // MAL is an optional enrichment source; the modal can still use its local
    // data when MAL is unavailable.
    return NextResponse.json({ ok: true, synced: false });
  }
}
