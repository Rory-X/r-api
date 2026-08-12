CREATE TABLE `notification_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` text NOT NULL,
	`idempotency_key_hash` text,
	`throttle_signature` text,
	`channel` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`occurred_at` text NOT NULL,
	`delivery_policy` text DEFAULT 'prefer_delivery' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`last_attempt_at` text,
	`last_outcome` text,
	`last_error` text,
	`delivered_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_notification_channel_unique` ON `notification_outbox` (`notification_id`,`channel`);--> statement-breakpoint
CREATE INDEX `notification_outbox_status_next_attempt_idx` ON `notification_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notification_outbox_lease_expires_at_idx` ON `notification_outbox` (`lease_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_idempotency_key_hash_unique` ON `notification_outbox` (`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `notification_outbox_created_at_idx` ON `notification_outbox` (`created_at`);--> statement-breakpoint
CREATE TABLE `notification_throttle_states` (
	`signature` text PRIMARY KEY NOT NULL,
	`last_enqueued_at` text NOT NULL,
	`suppressed_count` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `notification_throttle_states_updated_at_idx` ON `notification_throttle_states` (`updated_at`);