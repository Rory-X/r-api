CREATE TABLE `credential_import_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`source_index` integer NOT NULL,
	`candidate_fingerprint` text NOT NULL,
	`source_format` text NOT NULL,
	`source_version` text,
	`source_platform` text,
	`provider` text,
	`kind` text NOT NULL,
	`identity_summary` text,
	`secret_summary` text NOT NULL,
	`compatible_targets` text NOT NULL,
	`expires_at` text,
	`disabled` integer DEFAULT false NOT NULL,
	`candidate_warnings` text,
	`validation_status` text NOT NULL,
	`validation_errors` text,
	`validation_warnings` text,
	`duplicate_of_index` integer,
	`status` text DEFAULT 'previewed' NOT NULL,
	`result_message` text,
	`account_id` integer,
	`vault_item_ids` text,
	`completed_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`job_id`) REFERENCES `credential_import_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_import_items_job_source_index_unique` ON `credential_import_items` (`job_id`,`source_index`);--> statement-breakpoint
CREATE INDEX `credential_import_items_job_status_idx` ON `credential_import_items` (`job_id`,`status`);--> statement-breakpoint
CREATE INDEX `credential_import_items_candidate_fingerprint_idx` ON `credential_import_items` (`candidate_fingerprint`);--> statement-breakpoint
CREATE INDEX `credential_import_items_account_id_idx` ON `credential_import_items` (`account_id`);--> statement-breakpoint
CREATE TABLE `credential_import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'previewed' NOT NULL,
	`target` text,
	`site_id` integer,
	`operator_id` text NOT NULL,
	`conflict_policy` text DEFAULT 'skip' NOT NULL,
	`source_format` text NOT NULL,
	`source_version` text,
	`source_platform` text,
	`detection_confidence` text NOT NULL,
	`detection_is_batch` integer DEFAULT false NOT NULL,
	`detection_warnings` text,
	`normalization_warnings` text,
	`batch_fingerprint` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`idempotency_key_hash` text,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`failure_message` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_import_jobs_idempotency_key_hash_unique` ON `credential_import_jobs` (`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `credential_import_jobs_request_fingerprint_idx` ON `credential_import_jobs` (`request_fingerprint`);--> statement-breakpoint
CREATE INDEX `credential_import_jobs_status_created_at_idx` ON `credential_import_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `credential_import_jobs_site_created_at_idx` ON `credential_import_jobs` (`site_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `credential_import_provenance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`item_id` integer NOT NULL,
	`target_entity_type` text NOT NULL,
	`target_entity_id` integer NOT NULL,
	`site_id` integer,
	`candidate_fingerprint` text NOT NULL,
	`source_format` text NOT NULL,
	`source_version` text,
	`source_platform` text,
	`provider` text,
	`operator_id` text NOT NULL,
	`conflict_policy` text NOT NULL,
	`import_action` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`job_id`) REFERENCES `credential_import_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `credential_import_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_import_provenance_item_entity_unique` ON `credential_import_provenance` (`item_id`,`target_entity_type`,`target_entity_id`);--> statement-breakpoint
CREATE INDEX `credential_import_provenance_target_entity_idx` ON `credential_import_provenance` (`target_entity_type`,`target_entity_id`);--> statement-breakpoint
CREATE INDEX `credential_import_provenance_site_created_at_idx` ON `credential_import_provenance` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `credential_import_provenance_fingerprint_idx` ON `credential_import_provenance` (`candidate_fingerprint`);