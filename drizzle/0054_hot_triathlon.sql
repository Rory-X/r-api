ALTER TABLE `local_connector_threads` ADD `last_active_at` text;--> statement-breakpoint
CREATE INDEX `local_connector_threads_last_active_at_idx` ON `local_connector_threads` (`last_active_at`);