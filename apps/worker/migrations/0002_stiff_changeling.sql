ALTER TABLE `post_analyses` ADD `requested_model_id` text;--> statement-breakpoint
ALTER TABLE `post_analyses` ADD `resolved_model_id` text;--> statement-breakpoint
ALTER TABLE `post_analyses` ADD `error_type` text;--> statement-breakpoint
ALTER TABLE `post_analyses` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `post_analyses` ADD `max_attempts` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `post_analyses` ADD `next_retry_at` text;--> statement-breakpoint
ALTER TABLE `post_analyses` DROP COLUMN `model_id`;