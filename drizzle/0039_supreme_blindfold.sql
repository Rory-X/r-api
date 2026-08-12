CREATE TABLE `interaction_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`interaction_id` text NOT NULL,
	`delivery_id` text,
	`event_type` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`interaction_id`) REFERENCES `interaction_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_events_delivery_id_unique` ON `interaction_events` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `interaction_events_interaction_created_idx` ON `interaction_events` (`interaction_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `interaction_events_type_created_idx` ON `interaction_events` (`event_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `interaction_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`source_request_key` text NOT NULL,
	`connection_id` text NOT NULL,
	`source_request_id` text NOT NULL,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`thread_id` text,
	`turn_id` text,
	`item_id` text,
	`request_payload` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`response_payload` text,
	`response_fingerprint` text,
	`response_source` text,
	`response_operator_id` text,
	`response_idempotency_key_hash` text,
	`response_committed_at` text,
	`response_delivery_count` integer DEFAULT 0 NOT NULL,
	`response_delivered_at` text,
	`resolved_at` text,
	`cancelled_at` text,
	`expires_at` text NOT NULL,
	`state_version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interaction_requests_delivery_count_non_negative" CHECK("interaction_requests"."response_delivery_count" >= 0),
	CONSTRAINT "interaction_requests_state_version_positive" CHECK("interaction_requests"."state_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interaction_requests_source_request_key_unique` ON `interaction_requests` (`source_request_key`);--> statement-breakpoint
CREATE INDEX `interaction_requests_device_status_idx` ON `interaction_requests` (`device_id`,`status`);--> statement-breakpoint
CREATE INDEX `interaction_requests_thread_created_idx` ON `interaction_requests` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `interaction_requests_status_expires_idx` ON `interaction_requests` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `interaction_requests_response_idempotency_idx` ON `interaction_requests` (`response_idempotency_key_hash`);