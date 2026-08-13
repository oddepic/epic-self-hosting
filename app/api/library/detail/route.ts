import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { AnimeDetailService } from "@/lib/services/anime-detail-service";

export async function GET(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  const animeId = Number(request.nextUrl.searchParams.get("animeId"));
  if (!animeId) {
    return NextResponse.json({ error: "animeId required" }, { status: 400 });
  }
  const seasonParam = request.nextUrl.searchParams.get("season");
  const season = seasonParam ? Number(seasonParam) : undefined;

  const detail = new AnimeDetailService(db).getDetail(animeId, season);
  if (!detail) {
    return NextResponse.json({ error: "anime_not_found" }, { status: 404 });
  }

  return NextResponse.json({ detail });
}
