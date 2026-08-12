ALTER TABLE `bridge_continuation_tasks` ADD `task_kind` text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE `bridge_continuation_tasks` ADD `submission_mode` text;--> statement-breakpoint
ALTER TABLE `bridge_continuation_tasks` ADD `pending_method` text;--> statement-breakpoint
ALTER TABLE `bridge_continuation_tasks` ADD `request_source` text;--> statement-breakpoint
ALTER TABLE `bridge_continuation_tasks` ADD `requested_by` text;--> statement-breakpoint
ALTER TABLE `bridge_continuation_tasks` ADD `source_adapter_id` text;--> statement-breakpoint
ALTER TABLE `bridge_continuation_tasks` ADD `request_idempotency_key_hash` text;--> statement-breakpoint
ALTER TABLE `bridge_continuation_tasks` ADD `prompt_fingerprint` text;--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_continuation_tasks_request_idempotency_key_unique` ON `bridge_continuation_tasks` (`request_idempotency_key_hash`);