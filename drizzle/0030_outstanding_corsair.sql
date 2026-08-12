CREATE TABLE `oauth_refresh_leases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_slot` integer NOT NULL,
	`lease_token` text NOT NULL,
	`lease_owner` text NOT NULL,
	`credential_version` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "oauth_refresh_leases_slot_positive" CHECK("oauth_refresh_leases"."provider_slot" > 0),
	CONSTRAINT "oauth_refresh_leases_credential_version_positive" CHECK("oauth_refresh_leases"."credential_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_leases_account_unique` ON `oauth_refresh_leases` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_leases_token_unique` ON `oauth_refresh_leases` (`lease_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_leases_provider_slot_unique` ON `oauth_refresh_leases` (`provider`,`provider_slot`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_leases_provider_idx` ON `oauth_refresh_leases` (`provider`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_leases_expires_at_idx` ON `oauth_refresh_leases` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_provider_states` (
	`provider` text PRIMARY KEY NOT NULL,
	`next_allowed_at` text,
	`last_started_at` text,
	`last_completed_at` text,
	`consecutive_failure_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `oauth_refresh_provider_states_next_allowed_at_idx` ON `oauth_refresh_provider_states` (`next_allowed_at`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_credential_payload` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_credential_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_refresh_state` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_refresh_failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_refresh_retry_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_refresh_last_attempt_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_refresh_last_success_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `oauth_refresh_last_error` text;--> statement-breakpoint
CREATE INDEX `accounts_oauth_refresh_state_idx` ON `accounts` (`oauth_refresh_state`);--> statement-breakpoint
CREATE INDEX `accounts_oauth_refresh_retry_at_idx` ON `accounts` (`oauth_refresh_retry_at`);