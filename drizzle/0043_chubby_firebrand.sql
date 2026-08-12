CREATE TABLE `interaction_card_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`dispatch_id` text NOT NULL,
	`subject_revision` integer NOT NULL,
	`target_status` text NOT NULL,
	`card_fingerprint` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`deadline_at` text NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`last_error` text,
	`delivered_at` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`dispatch_id`) REFERENCES `interaction_dispatches`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interaction_card_updates_subject_revision_positive" CHECK("interaction_card_updates"."subject_revision" > 0),
	CONSTRAINT "interaction_card_updates_attempt_count_non_negative" CHECK("interaction_card_updates"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_card_updates_dispatch_fingerprint_unique` ON `interaction_card_updates` (`dispatch_id`,`card_fingerprint`);--> statement-breakpoint
CREATE INDEX `interaction_card_updates_status_next_attempt_idx` ON `interaction_card_updates` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `interaction_card_updates_dispatch_created_idx` ON `interaction_card_updates` (`dispatch_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `interaction_card_updates_deadline_idx` ON `interaction_card_updates` (`deadline_at`);