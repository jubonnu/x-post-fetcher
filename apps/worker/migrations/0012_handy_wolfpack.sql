CREATE TABLE `followed_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`last_client_request_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `followed_products_user_product_unique` ON `followed_products` (`user_id`,`product_id`) WHERE "followed_products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `followed_products_user_id_idx` ON `followed_products` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_favorites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`lottery_id` integer NOT NULL,
	`last_client_request_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_favorites_user_lottery_unique` ON `user_favorites` (`user_id`,`lottery_id`) WHERE "user_favorites"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `user_favorites_user_id_idx` ON `user_favorites` (`user_id`);