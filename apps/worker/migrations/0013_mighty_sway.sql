CREATE TABLE `checklist_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`lottery_id` integer NOT NULL,
	`step_id` text NOT NULL,
	`label` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`completed_at` text,
	`completed_note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`server_version` integer DEFAULT 1 NOT NULL,
	`last_client_request_id` text,
	`client_action_at` text,
	`server_received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checklist_progress_user_lottery_step_unique` ON `checklist_progress` (`user_id`,`lottery_id`,`step_id`) WHERE "checklist_progress"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `checklist_progress_user_lottery_idx` ON `checklist_progress` (`user_id`,`lottery_id`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`scope` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_records_scope_request_unique` ON `idempotency_records` (`user_id`,`scope`,`client_request_id`);