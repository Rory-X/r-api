ALTER TABLE `route_channels` ADD `retry_owner` text DEFAULT 'cooperative' NOT NULL;--> statement-breakpoint
ALTER TABLE `route_channels` ADD `upstream_retry_mode` text DEFAULT 'unknown' NOT NULL;