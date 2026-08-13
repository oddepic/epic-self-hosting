import { NextRequest, NextResponse } from "next/server";
import { SearchService } from "@/lib/services/search-service";
import { AniListHttpClient } from "@/lib/integrations/anilist-client";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ items: [] });
  }

  const service = new SearchService(new AniListHttpClient());
  const items = await service.search(query);
  return NextResponse.json({ items });
}
