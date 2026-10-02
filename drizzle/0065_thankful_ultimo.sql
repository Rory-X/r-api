CREATE TABLE `downstream_key_limit_policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`downstream_api_key_id` integer NOT NULL,
	`metric` text NOT NULL,
	`scope_type` text DEFAULT 'key' NOT NULL,
	`scope_value` text,
	`window_type` text NOT NULL,
	`window_seconds` integer,
	`limit_value` real NOT NULL,
	`burst_value` real DEFAULT 0 NOT NULL,
	`enforcement` text DEFAULT 'hard' NOT NULL,
	`warning_thresholds_json` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`downstream_api_key_id`) REFERENCES `downstream_api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_key_limit_policies_key_metric_scope_window_unique` ON `downstream_key_limit_policies` (`downstream_api_key_id`,`metric`,`scope_type`,`scope_value`,`window_type`,`window_seconds`);--> statement-breakpoint
CREATE INDEX `downstream_key_limit_policies_key_enabled_idx` ON `downstream_key_limit_policies` (`downstream_api_key_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `downstream_key_limit_policies_metric_window_idx` ON `downstream_key_limit_policies` (`metric`,`window_type`);--> statement-breakpoint
CREATE TABLE `downstream_key_quota_reservations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reservation_token` text NOT NULL,
	`downstream_api_key_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount_json` text NOT NULL,
	`window_ids_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`settled_at` text,
	`released_at` text,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`downstream_api_key_id`) REFERENCES `downstream_api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_key_quota_reservations_token_unique` ON `downstream_key_quota_reservations` (`reservation_token`);--> statement-breakpoint
CREATE INDEX `downstream_key_quota_reservations_status_expiry_idx` ON `downstream_key_quota_reservations` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `downstream_key_quota_reservations_key_created_idx` ON `downstream_key_quota_reservations` (`downstream_api_key_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `downstream_key_usage_windows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`policy_id` integer NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`used_value` real DEFAULT 0 NOT NULL,
	`reserved_value` real DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`policy_id`) REFERENCES `downstream_key_limit_policies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "downstream_key_usage_windows_non_negative" CHECK("downstream_key_usage_windows"."used_value" >= 0 and "downstream_key_usage_windows"."reserved_value" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_key_usage_windows_policy_window_unique` ON `downstream_key_usage_windows` (`policy_id`,`window_start`);--> statement-breakpoint
CREATE INDEX `downstream_key_usage_windows_window_end_idx` ON `downstream_key_usage_windows` (`window_end`);--> statement-breakpoint
CREATE INDEX `downstream_key_usage_windows_policy_updated_idx` ON `downstream_key_usage_windows` (`policy_id`,`updated_at`);