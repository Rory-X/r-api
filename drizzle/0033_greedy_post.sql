CREATE TABLE `browser_credential_recovery_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` integer NOT NULL,
	`account_id` integer,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`credential_name` text NOT NULL,
	`credential_kind` text DEFAULT 'browser_storage' NOT NULL,
	`adapter_platform` text NOT NULL,
	`target_url` text NOT NULL,
	`contract_snapshot` text NOT NULL,
	`task_token_hash` text,
	`claim_token_hash` text,
	`claimed_by` text,
	`claimed_at` text,
	`completed_at` text,
	`cancelled_at` text,
	`result_credential_id` integer,
	`error_code` text,
	`error_message` text,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`result_credential_id`) REFERENCES `credential_vault_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `browser_credential_recovery_tasks_site_id_idx` ON `browser_credential_recovery_tasks` (`site_id`);--> statement-breakpoint
CREATE INDEX `browser_credential_recovery_tasks_account_id_idx` ON `browser_credential_recovery_tasks` (`account_id`);--> statement-breakpoint
CREATE INDEX `browser_credential_recovery_tasks_status_idx` ON `browser_credential_recovery_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `browser_credential_recovery_tasks_expires_at_idx` ON `browser_credential_recovery_tasks` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_credential_recovery_tasks_task_token_hash_unique` ON `browser_credential_recovery_tasks` (`task_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_credential_recovery_tasks_claim_token_hash_unique` ON `browser_credential_recovery_tasks` (`claim_token_hash`);