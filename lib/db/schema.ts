import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const userStatus = [
  "watching",
  "completed",
  "plan_to_watch",
  "on_hold",
  "dropped",
] as const;

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  preferences: text("preferences", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("users_username_unique").on(t.username)]);

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const malTokens = sqliteTable("mal_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("mal_tokens_user_unique").on(t.userId)]);

export const animes = sqliteTable("animes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  anilistId: integer("anilist_id").notNull(),
  malId: integer("mal_id"),
  tvdbId: integer("tvdb_id"),
  jellyfinId: text("jellyfin_id"),
  sonarrId: integer("sonarr_id"),
  titleRomaji: text("title_romaji").notNull(),
  titleEnglish: text("title_english"),
  titleNative: text("title_native"),
  synonyms: text("synonyms", { mode: "json" }).$type<string[]>().notNull().default([]),
  synopsis: text("synopsis"),
  coverImageUrl: text("cover_image_url"),
  bannerImageUrl: text("banner_image_url"),
  genres: text("genres", { mode: "json" }).$type<string[]>().notNull().default([]),
  status: text("status").$type<typeof userStatus[number]>().notNull().default("plan_to_watch"),
  format: text("format"),
  seasonYear: integer("season_year"),
  episodeCount: integer("episode_count"),
  nextEpisodeAt: integer("next_episode_at"),
  lastWatchedAt: integer("last_watched_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [uniqueIndex("animes_anilist_unique").on(t.anilistId)]);

export const seasons = sqliteTable("seasons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  animeId: integer("anime_id").notNull().references(() => animes.id),
  number: integer("number").notNull(),
}, (t) => [uniqueIndex("seasons_anime_number_unique").on(t.animeId, t.number)]);

export const episodes = sqliteTable("episodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  seasonId: integer("season_id").notNull().references(() => seasons.id),
  episodeNumber: integer("episode_number").notNull(),
  absoluteNumber: integer("absolute_number"),
  jellyfinItemId: text("jellyfin_item_id"),
  sonarrEpisodeId: integer("sonarr_episode_id"),
  title: text("title"),
  thumbnailUrl: text("thumbnail_url"),
  durationSeconds: integer("duration_seconds"),
  watched: integer("watched", { mode: "boolean" }).notNull().default(false),
  progressSeconds: integer("progress_seconds").notNull().default(0),
  available: integer("available", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("episodes_season_number_unique").on(t.seasonId, t.episodeNumber)]);

export const playbackHistory = sqliteTable("playback_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  episodeId: integer("episode_id").notNull().references(() => episodes.id),
  userId: integer("user_id").notNull().references(() => users.id),
  timestamp: integer("timestamp").notNull(),
  positionSeconds: integer("position_seconds").notNull().default(0),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
});

export const trackPreferences = sqliteTable("track_preferences", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  animeId: integer("anime_id").references(() => animes.id),
  userId: integer("user_id").notNull().references(() => users.id),
  audioLanguage: text("audio_language"),
  subtitleLanguage: text("subtitle_language"),
  subtitleForced: integer("subtitle_forced", { mode: "boolean" }).notNull().default(false),
}, (t) => [uniqueIndex("track_prefs_anime_user_unique").on(t.animeId, t.userId)]);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Anime = typeof animes.$inferSelect;
export type Season = typeof seasons.$inferSelect;
export type Episode = typeof episodes.$inferSelect;
export type PlaybackHistoryRow = typeof playbackHistory.$inferSelect;
export type TrackPreference = typeof trackPreferences.$inferSelect;
