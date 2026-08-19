CREATE TABLE `scrape_author_states` (
	`author_username` text PRIMARY KEY NOT NULL,
	`needs_recovery` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
