PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_track_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anime_id` integer,
	`user_id` integer NOT NULL,
	`audio_language` text,
	`subtitle_language` text,
	`subtitle_forced` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`anime_id`) REFERENCES `animes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_track_preferences`("id", "anime_id", "user_id", "audio_language", "subtitle_language", "subtitle_forced") SELECT "id", "anime_id", "user_id", "audio_language", "subtitle_language", "subtitle_forced" FROM `track_preferences`;--> statement-breakpoint
DROP TABLE `track_preferences`;--> statement-breakpoint
ALTER TABLE `__new_track_preferences` RENAME TO `track_preferences`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `track_prefs_anime_user_unique` ON `track_preferences` (`anime_id`,`user_id`);