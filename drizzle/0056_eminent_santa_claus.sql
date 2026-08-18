CREATE TABLE `local_connector_health_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`check_id` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`reason` text,
	`observed_at` text,
	`transitioned_at` text,
	`incident_started_at` text,
	`alerted_at` text,
	`recovery_notified_at` text,
	`auto_repair_action_id` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_connector_health_checks_device_check_unique` ON `local_connector_health_checks` (`device_id`,`check_id`);--> statement-breakpoint
CREATE INDEX `local_connector_health_checks_status_observed_idx` ON `local_connector_health_checks` (`status`,`observed_at`);