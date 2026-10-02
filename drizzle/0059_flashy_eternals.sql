CREATE TABLE `credential_lifecycle_audits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`site_id` integer,
	`provider` text,
	`credential_source` text DEFAULT 'unknown' NOT NULL,
	`operator_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text NOT NULL,
	`message` text,
	`metadata` text,
	`dedupe_key` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_lifecycle_audits_dedupe_key_unique` ON `credential_lifecycle_audits` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `credential_lifecycle_audits_entity_created_at_idx` ON `credential_lifecycle_audits` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credential_lifecycle_audits_source_created_at_idx` ON `credential_lifecycle_audits` (`credential_source`,`created_at`);--> statement-breakpoint
CREATE INDEX `credential_lifecycle_audits_operator_created_at_idx` ON `credential_lifecycle_audits` (`operator_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credential_lifecycle_audits_status_created_at_idx` ON `credential_lifecycle_audits` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `credential_lifecycle_audits_action_created_at_idx` ON `credential_lifecycle_audits` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `credential_refresh_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text DEFAULT 'account' NOT NULL,
	`entity_id` integer NOT NULL,
	`site_id` integer,
	`provider` text,
	`refresh_owner` text DEFAULT 'r_api' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`failure_class` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`next_attempt_at` text,
	`last_attempt_at` text,
	`last_success_at` text,
	`last_error` text,
	`lease_owner` text,
	`lease_expires_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "credential_refresh_jobs_attempt_count_non_negative" CHECK("credential_refresh_jobs"."attempt_count" >= 0),
	CONSTRAINT "credential_refresh_jobs_max_attempts_positive" CHECK("credential_refresh_jobs"."max_attempts" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_refresh_jobs_entity_unique` ON `credential_refresh_jobs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `credential_refresh_jobs_status_next_attempt_idx` ON `credential_refresh_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `credential_refresh_jobs_provider_status_idx` ON `credential_refresh_jobs` (`provider`,`status`);--> statement-breakpoint
CREATE INDEX `credential_refresh_jobs_site_id_idx` ON `credential_refresh_jobs` (`site_id`);--> statement-breakpoint
CREATE INDEX `credential_refresh_jobs_failure_class_idx` ON `credential_refresh_jobs` (`failure_class`);