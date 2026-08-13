import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { LibraryService, type AnimeStatus } from "@/lib/services/library-service";

const VALID_EXCLUDES = new Set<AnimeStatus>(["watching", "completed", "plan_to_watch", "on_hold", "dropped"]);

export async function GET(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const service = new LibraryService(db);

  const search = request.nextUrl.searchParams.get("q") ?? undefined;
  const rawExcludes = request.nextUrl.searchParams.get("exclude") ?? "";
  const exclude = rawExcludes
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AnimeStatus => VALID_EXCLUDES.has(s as AnimeStatus));

  const sections = service.getLibrary({ search, exclude });
  return NextResponse.json({ sections });
}
