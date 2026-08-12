CREATE TABLE `bridge_continuation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`task_id`) REFERENCES `bridge_continuation_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bridge_continuation_events_task_created_idx` ON `bridge_continuation_events` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `bridge_continuation_events_type_created_idx` ON `bridge_continuation_events` (`event_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `bridge_continuation_leases` (
	`session_key` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`lease_token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`task_id`) REFERENCES `bridge_continuation_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_continuation_leases_task_id_unique` ON `bridge_continuation_leases` (`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_continuation_leases_token_hash_unique` ON `bridge_continuation_leases` (`lease_token_hash`);--> statement-breakpoint
CREATE INDEX `bridge_continuation_leases_expires_at_idx` ON `bridge_continuation_leases` (`expires_at`);--> statement-breakpoint
CREATE TABLE `bridge_continuation_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text,
	`session_key` text NOT NULL,
	`active_slot` integer,
	`thread_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`policy_snapshot` text NOT NULL,
	`policy_fingerprint` text NOT NULL,
	`continuation_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`next_run_at` text,
	`thread_status` text DEFAULT 'unknown' NOT NULL,
	`active_flags` text DEFAULT '[]' NOT NULL,
	`active_turn_id` text,
	`last_failure_class` text,
	`last_failure_source` text,
	`last_failure_recoverability` text,
	`last_codex_error_code` text,
	`last_http_status_code` integer,
	`last_message_summary` text,
	`last_message_fingerprint` text,
	`last_will_retry` integer,
	`last_failure_turn_terminal` integer DEFAULT false NOT NULL,
	`retry_after_ms` integer,
	`pending_route_action` text,
	`pending_prompt` text,
	`state_version` integer DEFAULT 1 NOT NULL,
	`stopped_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "bridge_continuation_tasks_continuation_count_non_negative" CHECK("bridge_continuation_tasks"."continuation_count" >= 0),
	CONSTRAINT "bridge_continuation_tasks_state_version_positive" CHECK("bridge_continuation_tasks"."state_version" > 0),
	CONSTRAINT "bridge_continuation_tasks_active_slot_valid" CHECK("bridge_continuation_tasks"."active_slot" is null or "bridge_continuation_tasks"."active_slot" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_continuation_tasks_session_active_unique` ON `bridge_continuation_tasks` (`session_key`,`active_slot`);--> statement-breakpoint
CREATE INDEX `bridge_continuation_tasks_device_id_idx` ON `bridge_continuation_tasks` (`device_id`);--> statement-breakpoint
CREATE INDEX `bridge_continuation_tasks_thread_id_idx` ON `bridge_continuation_tasks` (`thread_id`);--> statement-breakpoint
CREATE INDEX `bridge_continuation_tasks_status_next_run_idx` ON `bridge_continuation_tasks` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `bridge_continuation_tasks_policy_fingerprint_idx` ON `bridge_continuation_tasks` (`policy_fingerprint`);