import type { MalClient, MalListEntry, MalToken } from "./types";

const AUTHORIZE_URL = "https://myanimelist.net/v1/oauth2/authorize";
const TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
const API_BASE = "https://api.myanimelist.net/v2";

export class MalHttpClient implements MalClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  createAuthUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "plain",
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<MalToken> {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      code_verifier: codeVerifier,
    });
    return this.requestToken(form);
  }

  async refreshAccessToken(refreshToken: string): Promise<MalToken> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
    });
    return this.requestToken(form);
  }

  private async requestToken(form: URLSearchParams): Promise<MalToken> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`MAL token exchange failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
  }

  async getMyList(accessToken: string): Promise<MalListEntry[]> {
    const entries: MalListEntry[] = [];
    let url: string | null = `${API_BASE}/users/@me/animelist?limit=1000&fields=list_status`;

    while (url) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`MAL list failed: ${response.status}`);
      }
      const body = (await response.json()) as {
        data: {
          node: { id: number; title: string };
          list_status: { status: MalListEntry["status"]; num_watched_episodes: number; score: number | null };
        }[];
        paging?: { next?: string | null };
      };
      for (const item of body.data) {
        entries.push({
          animeId: item.node.id,
          title: item.node.title,
          status: item.list_status.status,
          watchedEpisodes: item.list_status.num_watched_episodes,
          score: item.list_status.score ?? null,
        });
      }
      url = body.paging?.next ?? null;
    }

    return entries;
  }

  async getListEntry(accessToken: string, animeId: number): Promise<MalListEntry | null> {
    const params = new URLSearchParams({ fields: "my_list_status" });
    const response = await fetch(`${API_BASE}/anime/${animeId}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`MAL anime status failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      id: number;
      title: string;
      my_list_status?: {
        status: MalListEntry["status"];
        num_watched_episodes: number;
        score: number | null;
      } | null;
    };
    const entry = body;
    const status = entry?.my_list_status;
    if (!entry || !status) return null;
    return {
      animeId: entry.id,
      title: entry.title,
      status: status.status,
      watchedEpisodes: status.num_watched_episodes,
      score: status.score ?? null,
    };
  }

  async updateStatus(
    accessToken: string,
    animeId: number,
    status: MalListEntry["status"],
    watchedEpisodes: number,
    score?: number | null,
  ): Promise<void> {
    const form = new URLSearchParams({ status, num_watched_episodes: String(watchedEpisodes) });
    if (score != null && score > 0) {
      form.set("score", String(score));
    }
    const response = await fetch(`${API_BASE}/anime/${animeId}/my_list_status`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!response.ok) {
      throw new Error(`MAL status update failed: ${response.status}`);
    }
  }
}
