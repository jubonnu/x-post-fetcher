CREATE TABLE `notification_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`deadline_reminder` integer NOT NULL,
	`announcement_reminder` integer NOT NULL,
	`purchase_reminder` integer NOT NULL,
	`new_lottery_alert` integer NOT NULL,
	`favorite_update_alert` integer NOT NULL,
	`push_enabled` integer NOT NULL,
	`email_enabled` integer NOT NULL,
	`quiet_hours_enabled` integer NOT NULL,
	`quiet_hours_start` text,
	`quiet_hours_end` text,
	`deadline_reminder_hours_before` integer NOT NULL,
	`announcement_reminder_hours_before` integer NOT NULL,
	`purchase_reminder_hours_before` integer NOT NULL,
	`server_version` integer DEFAULT 1 NOT NULL,
	`last_client_request_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_user_id_unique` ON `notification_preferences` (`user_id`);