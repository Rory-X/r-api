CREATE TABLE `downstream_api_key_leases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`downstream_api_key_id` integer NOT NULL,
	`lease_token` text NOT NULL,
	`slot` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`downstream_api_key_id`) REFERENCES `downstream_api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "downstream_api_key_leases_slot_positive" CHECK("downstream_api_key_leases"."slot" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_api_key_leases_token_unique` ON `downstream_api_key_leases` (`lease_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `downstream_api_key_leases_key_slot_unique` ON `downstream_api_key_leases` (`downstream_api_key_id`,`slot`);--> statement-breakpoint
CREATE INDEX `downstream_api_key_leases_key_id_idx` ON `downstream_api_key_leases` (`downstream_api_key_id`);--> statement-breakpoint
CREATE INDEX `downstream_api_key_leases_expires_at_idx` ON `downstream_api_key_leases` (`expires_at`);--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `max_concurrency` integer;--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `policy_version` integer DEFAULT 1 NOT NULL;