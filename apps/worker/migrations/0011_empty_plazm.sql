CREATE TABLE `user_lotteries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`lottery_id` integer NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`snapshot_json` text,
	`snapshot_updated_at` text,
	`saved_at` text NOT NULL,
	`server_version` integer DEFAULT 1 NOT NULL,
	`last_client_request_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_lotteries_user_lottery_unique` ON `user_lotteries` (`user_id`,`lottery_id`) WHERE "user_lotteries"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `user_lotteries_user_id_idx` ON `user_lotteries` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_lotteries_user_id_status_idx` ON `user_lotteries` (`user_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_lottery_status_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_lottery_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`changed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `user_lottery_status_history_user_lottery_id_idx` ON `user_lottery_status_history` (`user_lottery_id`);--> statement-breakpoint
CREATE INDEX `user_lottery_status_history_changed_at_idx` ON `user_lottery_status_history` (`changed_at`);