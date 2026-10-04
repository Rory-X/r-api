CREATE TABLE `site_concurrency_leases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`lease_token` text NOT NULL,
	`slot` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_concurrency_leases_slot_positive" CHECK("site_concurrency_leases"."slot" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_concurrency_leases_token_unique` ON `site_concurrency_leases` (`lease_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_concurrency_leases_site_slot_unique` ON `site_concurrency_leases` (`site_id`,`slot`);--> statement-breakpoint
CREATE INDEX `site_concurrency_leases_site_id_idx` ON `site_concurrency_leases` (`site_id`);--> statement-breakpoint
CREATE INDEX `site_concurrency_leases_expires_at_idx` ON `site_concurrency_leases` (`expires_at`);--> statement-breakpoint
ALTER TABLE `sites` ADD `max_concurrency` integer;--> statement-breakpoint
ALTER TABLE `sites` ADD `concurrency_wait_timeout_ms` integer DEFAULT 0 NOT NULL;