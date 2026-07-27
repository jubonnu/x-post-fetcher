CREATE TABLE `processing_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source_post_id` integer,
	`lottery_id` integer,
	`payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`next_retry_at` text,
	`last_error` text,
	`locked_at` text,
	`locked_by` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `lotteries` ADD `resolved_application_url` text;--> statement-breakpoint
ALTER TABLE `lotteries` ADD `application_url_http_status` integer;--> statement-breakpoint
ALTER TABLE `lotteries` ADD `url_resolved_at` text;