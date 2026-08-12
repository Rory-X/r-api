CREATE TABLE `model_sync_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`consecutive_missing` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text,
	`last_sync_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_sync_states_account_model_unique` ON `model_sync_states` (`account_id`,`model_name`);--> statement-breakpoint
CREATE INDEX `model_sync_states_account_status_idx` ON `model_sync_states` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `model_sync_states_last_sync_at_idx` ON `model_sync_states` (`last_sync_at`);