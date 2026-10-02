CREATE TABLE `alert_incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`rule_key` text NOT NULL,
	`severity` text DEFAULT 'error' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`acknowledged_at` text,
	`acknowledged_by` text,
	`resolved_at` text,
	`suppressed_until` text,
	`escalation_step` integer DEFAULT 0 NOT NULL,
	`next_escalation_at` text,
	`last_notified_at` text,
	`last_message` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_incidents_fingerprint_unique` ON `alert_incidents` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `alert_incidents_status_escalation_idx` ON `alert_incidents` (`status`,`next_escalation_at`);--> statement-breakpoint
CREATE INDEX `alert_incidents_rule_status_idx` ON `alert_incidents` (`rule_key`,`status`);--> statement-breakpoint
CREATE INDEX `alert_incidents_entity_idx` ON `alert_incidents` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `alert_incidents_last_seen_idx` ON `alert_incidents` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `alert_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`incident_id` integer NOT NULL,
	`observed_at` text NOT NULL,
	`value_json` text,
	`message` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`incident_id`) REFERENCES `alert_incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_occurrences_incident_observed_idx` ON `alert_occurrences` (`incident_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `alert_policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`grouping_window_sec` integer DEFAULT 300 NOT NULL,
	`steps_json` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_policies_rule_key_unique` ON `alert_policies` (`rule_key`);--> statement-breakpoint
CREATE INDEX `alert_policies_enabled_idx` ON `alert_policies` (`enabled`);