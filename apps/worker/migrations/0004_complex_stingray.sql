CREATE TABLE `lottery_field_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lottery_id` integer NOT NULL,
	`source_post_id` integer,
	`field_name` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`change_type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lottery_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lottery_id` integer NOT NULL,
	`source_post_id` integer NOT NULL,
	`match_action` text,
	`match_score` text,
	`match_reason` text,
	`contributed_fields` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
