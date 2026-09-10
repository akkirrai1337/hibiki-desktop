CREATE TABLE `anilist_matches` (
	`source_id` text NOT NULL,
	`anime_id` text NOT NULL,
	`anilist_id` integer,
	`confidence` integer,
	`manual` integer DEFAULT false NOT NULL,
	`matched_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `anime_id`)
);
--> statement-breakpoint
CREATE TABLE `anilist_media` (
	`anilist_id` integer PRIMARY KEY NOT NULL,
	`media_json` text NOT NULL,
	`cached_at` integer NOT NULL
);
