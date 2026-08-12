CREATE TABLE `credential_vault_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer,
	`account_id` integer,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`ciphertext` text NOT NULL,
	`fingerprint` text NOT NULL,
	`metadata` text,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `credential_vault_items_site_id_idx` ON `credential_vault_items` (`site_id`);--> statement-breakpoint
CREATE INDEX `credential_vault_items_account_id_idx` ON `credential_vault_items` (`account_id`);--> statement-breakpoint
CREATE INDEX `credential_vault_items_status_idx` ON `credential_vault_items` (`status`);--> statement-breakpoint
CREATE INDEX `credential_vault_items_fingerprint_idx` ON `credential_vault_items` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `credential_vault_items_expires_at_idx` ON `credential_vault_items` (`expires_at`);