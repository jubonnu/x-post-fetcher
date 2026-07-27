ALTER TABLE `lotteries` ADD `lifecycle_status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `lotteries` ADD `orphaned_at` text;