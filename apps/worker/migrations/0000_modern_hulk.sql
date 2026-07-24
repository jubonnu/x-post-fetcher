CREATE TABLE `source_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`platform` text DEFAULT 'x' NOT NULL,
	`external_post_id` text NOT NULL,
	`author_id` text,
	`author_username` text,
	`author_display_name` text,
	`body_raw` text,
	`published_at` text,
	`source_url` text,
	`image_urls` text,
	`external_urls` text,
	`raw_html` text,
	`cleaned_html` text,
	`content_hash` text,
	`fetched_at` text,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_posts_external_post_id_unique` ON `source_posts` (`external_post_id`);