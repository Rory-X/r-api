CREATE TABLE `proxy_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`requested_model` text NOT NULL,
	`downstream_path` text NOT NULL,
	`client_kind` text,
	`session_id` text,
	`downstream_api_key_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`retry_owner` text DEFAULT 'cooperative' NOT NULL,
	`replay_safety` text DEFAULT 'safe_only' NOT NULL,
	`policy_snapshot_json` text NOT NULL,
	`retry_budget_json` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`finished_at` text,
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_requests_request_id_unique` ON `proxy_requests` (`request_id`);--> statement-breakpoint
CREATE INDEX `proxy_requests_status_updated_at_idx` ON `proxy_requests` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `proxy_requests_session_created_at_idx` ON `proxy_requests` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `proxy_requests_model_created_at_idx` ON `proxy_requests` (`requested_model`,`created_at`);--> statement-breakpoint
CREATE TABLE `proxy_request_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_row_id` integer NOT NULL,
	`attempt_id` text NOT NULL,
	`attempt_index` integer NOT NULL,
	`channel_id` integer,
	`account_id` integer,
	`token_id` integer,
	`endpoint` text,
	`request_path` text,
	`target_url` text,
	`status` text DEFAULT 'in_flight' NOT NULL,
	`commit_state` text DEFAULT 'not_started' NOT NULL,
	`error_scope` text,
	`status_code` integer,
	`error_summary` text,
	`started_at` text DEFAULT (datetime('now')),
	`finished_at` text,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`request_row_id`) REFERENCES `proxy_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_request_attempts_request_attempt_unique` ON `proxy_request_attempts` (`request_row_id`,`attempt_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_request_attempts_attempt_id_unique` ON `proxy_request_attempts` (`attempt_id`);--> statement-breakpoint
CREATE INDEX `proxy_request_attempts_request_status_idx` ON `proxy_request_attempts` (`request_row_id`,`status`);--> statement-breakpoint
CREATE INDEX `proxy_request_attempts_channel_started_at_idx` ON `proxy_request_attempts` (`channel_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `proxy_request_attempts_commit_state_idx` ON `proxy_request_attempts` (`commit_state`,`updated_at`);
