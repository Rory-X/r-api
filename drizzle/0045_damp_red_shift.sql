CREATE TABLE `admin_auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`encrypted_payload` text,
	`client_ip` text,
	`user_agent` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_auth_challenges_token_hash_unique` ON `admin_auth_challenges` (`token_hash`);--> statement-breakpoint
CREATE INDEX `admin_auth_challenges_expires_at_idx` ON `admin_auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `admin_auth_challenges_consumed_at_idx` ON `admin_auth_challenges` (`consumed_at`);--> statement-breakpoint
CREATE TABLE `admin_totp_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`encrypted_secret` text NOT NULL,
	`recovery_code_hashes` text NOT NULL,
	`last_accepted_counter` integer,
	`enabled_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
ALTER TABLE `admin_sessions` ADD `second_factor_verified_at` text;