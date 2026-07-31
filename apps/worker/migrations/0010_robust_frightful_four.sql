CREATE TABLE `lottery_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lottery_id` integer NOT NULL,
	`product_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lottery_products_lottery_product_unique` ON `lottery_products` (`lottery_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `lottery_products_product_id_idx` ON `lottery_products` (`product_id`);--> statement-breakpoint
CREATE TABLE `product_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`alias_name` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`normalizer_version` text,
	`source` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_aliases_normalized_alias_version_unique` ON `product_aliases` (`normalized_alias`,`normalizer_version`);--> statement-breakpoint
CREATE INDEX `product_aliases_product_id_idx` ON `product_aliases` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_product_id` text NOT NULL,
	`canonical_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`normalizer_version` text,
	`lifecycle_status` text DEFAULT 'active' NOT NULL,
	`merged_into_product_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "products_lifecycle_status_check" CHECK("products"."lifecycle_status" IN ('active', 'merged', 'archived')),
	CONSTRAINT "products_no_self_merge_check" CHECK("products"."merged_into_product_id" IS NULL OR "products"."merged_into_product_id" != "products"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_public_product_id_unique` ON `products` (`public_product_id`);--> statement-breakpoint
CREATE INDEX `products_normalized_name_idx` ON `products` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `products_lifecycle_status_idx` ON `products` (`lifecycle_status`);