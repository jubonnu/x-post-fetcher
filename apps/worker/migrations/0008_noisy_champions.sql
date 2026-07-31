CREATE TABLE `account_deletion_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`scheduled_deletion_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cancelled_at` text,
	`completed_at` text,
	`reason` text,
	`apple_revocation_status` text DEFAULT 'not_applicable' NOT NULL,
	`apple_revocation_attempts` integer DEFAULT 0 NOT NULL,
	`apple_revocation_last_attempt_at` text,
	`apple_revocation_last_error` text,
	`apple_revocation_next_retry_at` text
);
--> statement-breakpoint
CREATE INDEX `account_deletion_requests_user_id_idx` ON `account_deletion_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `account_deletion_requests_apple_revocation_status_idx` ON `account_deletion_requests` (`apple_revocation_status`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`action` text NOT NULL,
	`detail_json` text,
	`ip_hash` text,
	`request_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_logs_user_id_idx` ON `audit_logs` (`user_id`);--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`device_id` text NOT NULL,
	`device_name` text,
	`rotated_from_id` integer,
	`issued_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`revoked_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refresh_tokens_token_hash_unique` ON `refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_user_id_idx` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `refresh_tokens_device_id_idx` ON `refresh_tokens` (`device_id`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`email` text,
	`apple_refresh_token_ciphertext` text,
	`apple_refresh_token_iv` text,
	`apple_refresh_token_key_version` text,
	`apple_token_obtained_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_unique` ON `user_identities` (`provider`,`provider_user_id`);--> statement-breakpoint
CREATE INDEX `user_identities_user_id_idx` ON `user_identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_user_id` text NOT NULL,
	`display_name` text,
	`email` text,
	`email_is_private_relay` integer,
	`account_status` text DEFAULT 'active' NOT NULL,
	`deletion_requested_at` text,
	`scheduled_deletion_at` text,
	`last_login_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_public_user_id_unique` ON `users` (`public_user_id`);--> statement-breakpoint
CREATE INDEX `users_account_status_idx` ON `users` (`account_status`);