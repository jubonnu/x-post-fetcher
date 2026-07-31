CREATE TABLE `revenuecat_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`revenue_cat_event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`app_user_id` text NOT NULL,
	`original_app_user_id` text,
	`aliases_json` text,
	`environment` text NOT NULL,
	`event_timestamp` text NOT NULL,
	`payload_hash` text NOT NULL,
	`processing_status` text DEFAULT 'pending' NOT NULL,
	`processed_at` text,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revenuecat_events_event_id_unique` ON `revenuecat_events` (`revenue_cat_event_id`);--> statement-breakpoint
CREATE INDEX `revenuecat_events_app_user_id_idx` ON `revenuecat_events` (`app_user_id`);--> statement-breakpoint
CREATE TABLE `subscription_entitlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`entitlement_id` text NOT NULL,
	`premium_active` integer DEFAULT false NOT NULL,
	`product_id` text,
	`product_type` text,
	`environment` text,
	`store` text,
	`original_transaction_id` text,
	`purchased_at` text,
	`expires_at` text,
	`ownership_type` text,
	`last_revenue_cat_event_at` text,
	`source` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_entitlements_user_id_unique` ON `subscription_entitlements` (`user_id`);