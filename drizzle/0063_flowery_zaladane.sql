ALTER TABLE `proxy_logs` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `proxy_logs_archived_at_idx` ON `proxy_logs` (`archived_at`,`created_at`);--> statement-breakpoint
ALTER TABLE `proxy_requests` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `proxy_requests_archived_at_idx` ON `proxy_requests` (`archived_at`,`updated_at`);