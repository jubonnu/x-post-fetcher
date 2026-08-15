CREATE TABLE `lottery_update_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_lottery_id` integer NOT NULL,
	`source_post_id` integer NOT NULL,
	`candidate_index` integer DEFAULT 0 NOT NULL,
	`candidate_key` text NOT NULL,
	`match_score` text,
	`match_reason` text,
	`extracted_data` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolved_by` text,
	`resolved_at` text,
	`applied_fields` text,
	`registered_lottery_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "lottery_update_candidates_status_check" CHECK("lottery_update_candidates"."status" IN ('pending', 'applied', 'registered_as_new', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lottery_update_candidates_source_candidate_unique` ON `lottery_update_candidates` (`source_post_id`,`candidate_key`);--> statement-breakpoint
CREATE INDEX `lottery_update_candidates_target_lottery_id_idx` ON `lottery_update_candidates` (`target_lottery_id`);--> statement-breakpoint
CREATE INDEX `lottery_update_candidates_status_idx` ON `lottery_update_candidates` (`status`);