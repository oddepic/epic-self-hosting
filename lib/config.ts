export interface AppConfig {
  serverName: string;
  userName: string;
  authPassword: string;
  databaseUrl: string;
  jellyfinUrl: string;
  jellyfinApiKey: string;
  jellyfinUserId: string;
  jellyfinWebhookSecret: string;
  jellyfinRefreshSecret: string;
  jellyfinServiceUsername: string;
  jellyfinServicePassword: string;
  sonarrUrl: string;
  sonarrApiKey: string;
  sonarrRootFolder: string;
  sonarrQualityProfileId: number;
  malClientId: string;
  malClientSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.AUTH_PASSWORD) {
    throw new Error("Missing required environment variable: AUTH_PASSWORD");
  }

  return {
    serverName: env.SERVER_NAME ?? "epic self-hosting",
    userName: env.USER_NAME ?? "admin",
    authPassword: env.AUTH_PASSWORD,
    databaseUrl: env.DATABASE_URL ?? "file:data.db",
    jellyfinUrl: env.JELLYFIN_URL ?? "",
    jellyfinApiKey: env.JELLYFIN_API_KEY ?? "",
    jellyfinUserId: env.JELLYFIN_USER_ID ?? "",
    jellyfinWebhookSecret: env.JELLYFIN_WEBHOOK_SECRET ?? "",
    jellyfinRefreshSecret: env.JELLYFIN_REFRESH_SECRET ?? "",
    jellyfinServiceUsername: env.JELLYFIN_SERVICE_USERNAME ?? "",
    jellyfinServicePassword: env.JELLYFIN_SERVICE_PASSWORD ?? "",
    sonarrUrl: env.SONARR_URL ?? "",
    sonarrApiKey: env.SONARR_API_KEY ?? "",
    sonarrRootFolder: env.SONARR_ROOT_FOLDER ?? "",
    sonarrQualityProfileId: Number(env.SONARR_QUALITY_PROFILE_ID ?? "0"),
    malClientId: env.MAL_CLIENT_ID ?? "",
    malClientSecret: env.MAL_CLIENT_SECRET ?? "",
  };
}
