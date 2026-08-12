CREATE TABLE `interaction_action_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_id` text NOT NULL,
	`interaction_id` text NOT NULL,
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
	FOREIGN KEY (`adapter_id`) REFERENCES `interaction_adapters`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interaction_action_tickets_state_version_positive" CHECK("interaction_action_tickets"."state_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_action_tickets_dispatch_action_unique` ON `interaction_action_tickets` (`dispatch_id`,`action_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_action_tickets_token_hash_unique` ON `interaction_action_tickets` (`token_hash`);--> statement-breakpoint
CREATE INDEX `interaction_action_tickets_status_expires_idx` ON `interaction_action_tickets` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `interaction_action_tickets_interaction_created_idx` ON `interaction_action_tickets` (`interaction_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `interaction_adapters` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`app_id` text NOT NULL,
	`app_secret_credential_id` integer,
	`verification_token_credential_id` integer,
	`encrypt_key_credential_id` integer,
	`api_base_url` text DEFAULT 'https://open.feishu.cn' NOT NULL,
	`receive_id_type` text DEFAULT 'chat_id' NOT NULL,
	`receive_id` text NOT NULL,
	`console_base_url` text,
	`operator_allowlist` text DEFAULT '[]' NOT NULL,
	`last_dispatch_at` text,
	`last_callback_at` text,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`app_secret_credential_id`) REFERENCES `credential_vault_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`verification_token_credential_id`) REFERENCES `credential_vault_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`encrypt_key_credential_id`) REFERENCES `credential_vault_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_adapters_kind_name_unique` ON `interaction_adapters` (`kind`,`name`);--> statement-breakpoint
CREATE INDEX `interaction_adapters_enabled_kind_idx` ON `interaction_adapters` (`enabled`,`kind`);--> statement-breakpoint
CREATE TABLE `interaction_dispatches` (
	`id` text PRIMARY KEY NOT NULL,
	`interaction_id` text NOT NULL,
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
	FOREIGN KEY (`adapter_id`) REFERENCES `interaction_adapters`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interaction_dispatches_attempt_count_non_negative" CHECK("interaction_dispatches"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_dispatches_interaction_adapter_unique` ON `interaction_dispatches` (`interaction_id`,`adapter_id`);--> statement-breakpoint
CREATE INDEX `interaction_dispatches_status_next_attempt_idx` ON `interaction_dispatches` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `interaction_dispatches_adapter_created_idx` ON `interaction_dispatches` (`adapter_id`,`created_at`);