ALTER TABLE `alert_incidents` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `alert_incidents` ADD `lease_expires_at` text;--> statement-breakpoint
CREATE INDEX `alert_incidents_lease_expires_at_idx` ON `alert_incidents` (`lease_expires_at`);