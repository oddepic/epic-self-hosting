import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db/client";
import { loadConfig } from "@/lib/config";
import { MalHttpClient } from "@/lib/integrations/mal-client";
import { AniListHttpClient } from "@/lib/integrations/anilist-client";
import { UserService } from "@/lib/services/user-service";
import { MalImportService } from "@/lib/services/mal-import-service";

const STATE_COOKIE = "mal_oauth_state";
const VERIFIER_COOKIE = "mal_oauth_verifier";

export async function GET(request: NextRequest) {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const user = await new UserService(db, config).ensureConfiguredUser();

  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const malError = request.nextUrl.searchParams.get("error");
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  const verifier = request.cookies.get(VERIFIER_COOKIE)?.value;

  const fail = (detail: string) => {
    const url = new URL("/settings", request.url);
    url.searchParams.set("mal", "error");
    url.searchParams.set("detail", detail);
    return NextResponse.redirect(url);
  };

  if (malError) {
    return fail(`MAL returned: ${malError}`);
  }
  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return fail("OAuth state or verifier mismatch. Try linking again.");
  }

  try {
    const client = new MalHttpClient(config.malClientId, config.malClientSecret);
    const tokens = await client.exchangeCode(code, verifier);

    const importService = new MalImportService(db, client, new AniListHttpClient());
    importService.saveTokens(user.id, tokens);

    const response = NextResponse.redirect(new URL("/settings?mal=linked", request.url));
    response.cookies.delete(STATE_COOKIE);
    response.cookies.delete(VERIFIER_COOKIE);
    return response;
  } catch (error) {
    console.error("MAL callback failed:", error);
    return fail("Token exchange failed. Check MAL_CLIENT_ID/SECRET.");
  }
}
