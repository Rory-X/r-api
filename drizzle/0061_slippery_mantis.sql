CREATE TABLE `downstream_key_day_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`local_day` text NOT NULL,
	`downstream_api_key_id` integer NOT NULL,
	`total_calls` integer DEFAULT 0 NOT NULL,
	`success_calls` integer DEFAULT 0 NOT NULL,
	`failed_calls` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	CONSTRAINT "downstream_key_day_usage_non_negative" CHECK("downstream_key_day_usage"."total_calls" >= 0 and "downstream_key_day_usage"."success_calls" >= 0 and "downstream_key_day_usage"."failed_calls" >= 0 and "downstream_key_day_usage"."total_tokens" >= 0 and "downstream_key_day_usage"."total_cost" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_key_day_usage_day_key_unique` ON `downstream_key_day_usage` (`local_day`,`downstream_api_key_id`);--> statement-breakpoint
CREATE INDEX `downstream_key_day_usage_day_idx` ON `downstream_key_day_usage` (`local_day`);--> statement-breakpoint
CREATE INDEX `downstream_key_day_usage_key_id_idx` ON `downstream_key_day_usage` (`downstream_api_key_id`);