CREATE TABLE `downstream_api_key_rate_windows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`downstream_api_key_id` integer NOT NULL,
	`window_kind` text NOT NULL,
	`window_start` text NOT NULL,
	`reserved_requests` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`downstream_api_key_id`) REFERENCES `downstream_api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_api_key_rate_windows_key_window_unique` ON `downstream_api_key_rate_windows` (`downstream_api_key_id`,`window_kind`,`window_start`);--> statement-breakpoint
CREATE INDEX `downstream_api_key_rate_windows_window_lookup_idx` ON `downstream_api_key_rate_windows` (`window_kind`,`window_start`);--> statement-breakpoint
CREATE INDEX `downstream_api_key_rate_windows_key_updated_idx` ON `downstream_api_key_rate_windows` (`downstream_api_key_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `requests_per_minute` integer;