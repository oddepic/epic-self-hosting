import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { MalHttpClient } from "@/lib/integrations/mal-client";

const STATE_COOKIE = "mal_oauth_state";
const VERIFIER_COOKIE = "mal_oauth_verifier";

export async function GET() {
  const config = loadConfig();
  if (!config.malClientId) {
    return NextResponse.json({ error: "MAL_CLIENT_ID not configured" }, { status: 503 });
  }

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const client = new MalHttpClient(config.malClientId, config.malClientSecret);
  const url = client.createAuthUrl(state, verifier);

  const response = NextResponse.redirect(url);
  response.cookies.set(STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  response.cookies.set(VERIFIER_COOKIE, verifier, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  return response;
}
