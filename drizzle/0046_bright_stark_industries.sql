CREATE TABLE `local_connector_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`thread_status` text DEFAULT 'unknown' NOT NULL,
	`active_flags` text DEFAULT '[]' NOT NULL,
	`active_turn_id` text,
	`last_event_kind` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_connector_threads_device_thread_unique` ON `local_connector_threads` (`device_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `local_connector_threads_device_last_seen_idx` ON `local_connector_threads` (`device_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `local_connector_threads_last_seen_at_idx` ON `local_connector_threads` (`last_seen_at`);