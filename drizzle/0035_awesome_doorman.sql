CREATE TABLE `local_connector_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`kind` text NOT NULL,
	`operation` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`manifest` text NOT NULL,
	`result_payload` text,
	`backup_ref` text,
	`error_message` text,
	`claimed_at` text,
	`completed_at` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `local_connector_actions_device_status_idx` ON `local_connector_actions` (`device_id`,`status`);--> statement-breakpoint
CREATE INDEX `local_connector_actions_status_expires_idx` ON `local_connector_actions` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `local_connector_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`version` text,
	`status` text DEFAULT 'active' NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`capabilities` text,
	`paired_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_connector_devices_token_hash_unique` ON `local_connector_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `local_connector_devices_status_idx` ON `local_connector_devices` (`status`);--> statement-breakpoint
CREATE INDEX `local_connector_devices_last_seen_at_idx` ON `local_connector_devices` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `local_connector_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`device_name` text NOT NULL,
	`requested_scopes` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_device_id` text,
	`expires_at` text NOT NULL,
	`claimed_at` text,
	`cancelled_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`claimed_device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_connector_pairings_token_hash_unique` ON `local_connector_pairings` (`token_hash`);--> statement-breakpoint
CREATE INDEX `local_connector_pairings_status_expires_idx` ON `local_connector_pairings` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `local_connector_pairings_claimed_device_idx` ON `local_connector_pairings` (`claimed_device_id`);