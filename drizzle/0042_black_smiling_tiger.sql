CREATE TABLE `interaction_prompt_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`device_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`context_task_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`requested_by` text NOT NULL,
	`request_idempotency_key_hash` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`consumed_task_id` text,
	`consumed_by` text,
	`consumed_at` text,
	`state_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`adapter_id`) REFERENCES `interaction_adapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_task_id`) REFERENCES `bridge_continuation_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`consumed_task_id`) REFERENCES `bridge_continuation_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "interaction_prompt_cards_state_version_positive" CHECK("interaction_prompt_cards"."state_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_prompt_cards_idempotency_key_unique` ON `interaction_prompt_cards` (`request_idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `interaction_prompt_cards_adapter_status_expires_idx` ON `interaction_prompt_cards` (`adapter_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `interaction_prompt_cards_device_thread_created_idx` ON `interaction_prompt_cards` (`device_id`,`thread_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_interaction_action_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_id` text NOT NULL,
	`interaction_id` text,
	`prompt_card_id` text,
	`adapter_id` text NOT NULL,
	`action_key` text NOT NULL,
	`token_hash` text NOT NULL,
	`response_payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_by` text,
	`state_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`dispatch_id`) REFERENCES `interaction_dispatches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`interaction_id`) REFERENCES `interaction_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_card_id`) REFERENCES `interaction_prompt_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adapter_id`) REFERENCES `interaction_adapters`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interaction_action_tickets_subject_check" CHECK(("__new_interaction_action_tickets"."interaction_id" is not null and "__new_interaction_action_tickets"."prompt_card_id" is null)
      or ("__new_interaction_action_tickets"."interaction_id" is null and "__new_interaction_action_tickets"."prompt_card_id" is not null)),
	CONSTRAINT "interaction_action_tickets_state_version_positive" CHECK("__new_interaction_action_tickets"."state_version" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_interaction_action_tickets`("id", "dispatch_id", "interaction_id", "prompt_card_id", "adapter_id", "action_key", "token_hash", "response_payload", "status", "expires_at", "consumed_at", "consumed_by", "state_version", "created_at", "updated_at") SELECT "id", "dispatch_id", "interaction_id", NULL, "adapter_id", "action_key", "token_hash", "response_payload", "status", "expires_at", "consumed_at", "consumed_by", "state_version", "created_at", "updated_at" FROM `interaction_action_tickets`;--> statement-breakpoint
DROP TABLE `interaction_action_tickets`;--> statement-breakpoint
ALTER TABLE `__new_interaction_action_tickets` RENAME TO `interaction_action_tickets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_action_tickets_dispatch_action_unique` ON `interaction_action_tickets` (`dispatch_id`,`action_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_action_tickets_token_hash_unique` ON `interaction_action_tickets` (`token_hash`);--> statement-breakpoint
CREATE INDEX `interaction_action_tickets_status_expires_idx` ON `interaction_action_tickets` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `interaction_action_tickets_interaction_created_idx` ON `interaction_action_tickets` (`interaction_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `interaction_action_tickets_prompt_card_created_idx` ON `interaction_action_tickets` (`prompt_card_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_interaction_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_kind` text DEFAULT 'interaction' NOT NULL,
	`interaction_id` text,
	`prompt_card_id` text,
	`adapter_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`external_message_id` text,
	`card_fingerprint` text,
	`last_error` text,
	`delivered_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`interaction_id`) REFERENCES `interaction_requests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`prompt_card_id`) REFERENCES `interaction_prompt_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`adapter_id`) REFERENCES `interaction_adapters`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interaction_dispatches_subject_kind_check" CHECK(("__new_interaction_dispatches"."subject_kind" = 'interaction' and "__new_interaction_dispatches"."interaction_id" is not null and "__new_interaction_dispatches"."prompt_card_id" is null)
      or ("__new_interaction_dispatches"."subject_kind" = 'prompt_card' and "__new_interaction_dispatches"."interaction_id" is null and "__new_interaction_dispatches"."prompt_card_id" is not null)),
	CONSTRAINT "interaction_dispatches_attempt_count_non_negative" CHECK("__new_interaction_dispatches"."attempt_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_interaction_dispatches`("id", "subject_kind", "interaction_id", "prompt_card_id", "adapter_id", "status", "attempt_count", "next_attempt_at", "lease_owner", "lease_token", "lease_expires_at", "external_message_id", "card_fingerprint", "last_error", "delivered_at", "created_at", "updated_at") SELECT "id", 'interaction', "interaction_id", NULL, "adapter_id", "status", "attempt_count", "next_attempt_at", "lease_owner", "lease_token", "lease_expires_at", "external_message_id", "card_fingerprint", "last_error", "delivered_at", "created_at", "updated_at" FROM `interaction_dispatches`;--> statement-breakpoint
DROP TABLE `interaction_dispatches`;--> statement-breakpoint
ALTER TABLE `__new_interaction_dispatches` RENAME TO `interaction_dispatches`;--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_dispatches_interaction_adapter_unique` ON `interaction_dispatches` (`interaction_id`,`adapter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_dispatches_prompt_card_adapter_unique` ON `interaction_dispatches` (`prompt_card_id`,`adapter_id`);--> statement-breakpoint
CREATE INDEX `interaction_dispatches_status_next_attempt_idx` ON `interaction_dispatches` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `interaction_dispatches_adapter_created_idx` ON `interaction_dispatches` (`adapter_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
