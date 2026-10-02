CREATE TABLE `archive_manifests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`resource` text NOT NULL,
	`status` text DEFAULT 'writing' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`min_id` integer,
	`max_id` integer,
	`min_created_at` text,
	`max_created_at` text,
	`storage_driver` text DEFAULT 'local' NOT NULL,
	`object_key` text,
	`byte_size` integer,
	`sha256` text,
	`started_at` text DEFAULT (datetime('now')),
	`committed_at` text,
	`deleted_at` text,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `archive_manifests_resource_created_at_idx` ON `archive_manifests` (`resource`,`created_at`);--> statement-breakpoint
CREATE INDEX `archive_manifests_status_updated_at_idx` ON `archive_manifests` (`status`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `archive_manifests_object_key_unique` ON `archive_manifests` (`object_key`);--> statement-breakpoint
CREATE INDEX `archive_manifests_max_id_idx` ON `archive_manifests` (`resource`,`max_id`);