CREATE TABLE `animes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anilist_id` integer NOT NULL,
	`mal_id` integer,
	`tvdb_id` integer,
	`jellyfin_id` text,
	`sonarr_id` integer,
	`title_romaji` text NOT NULL,
	`title_english` text,
	`title_native` text,
	`synonyms` text DEFAULT '[]' NOT NULL,
	`synopsis` text,
	`cover_image_url` text,
	`banner_image_url` text,
	`genres` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'plan_to_watch' NOT NULL,
	`format` text,
	`season_year` integer,
	`episode_count` integer,
	`next_episode_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `animes_anilist_unique` ON `animes` (`anilist_id`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`season_id` integer NOT NULL,
	`episode_number` integer NOT NULL,
	`absolute_number` integer,
	`jellyfin_item_id` text,
	`sonarr_episode_id` integer,
	`duration_seconds` integer,
	`watched` integer DEFAULT false NOT NULL,
	`progress_seconds` integer DEFAULT 0 NOT NULL,
	`available` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_season_number_unique` ON `episodes` (`season_id`,`episode_number`);--> statement-breakpoint
CREATE TABLE `playback_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`episode_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`position_seconds` integer DEFAULT 0 NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`number` integer NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `animes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seasons_anime_number_unique` ON `seasons` (`anime_id`,`number`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `track_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`audio_language` text,
	`subtitle_language` text,
	`subtitle_forced` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `animes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `track_prefs_anime_user_unique` ON `track_preferences` (`anime_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`preferences` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);