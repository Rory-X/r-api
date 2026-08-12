CREATE TABLE `feishu_topic_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter_id` text NOT NULL,
	`device_id` text NOT NULL,
	`codex_thread_id` text NOT NULL,
	`root_message_id` text,
	`feishu_thread_id` text,
	`last_message_id` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`adapter_id`) REFERENCES `interaction_adapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `local_connector_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_topic_bindings_adapter_device_thread_unique` ON `feishu_topic_bindings` (`adapter_id`,`device_id`,`codex_thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_topic_bindings_adapter_root_message_unique` ON `feishu_topic_bindings` (`adapter_id`,`root_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `feishu_topic_bindings_adapter_feishu_thread_unique` ON `feishu_topic_bindings` (`adapter_id`,`feishu_thread_id`);--> statement-breakpoint
CREATE INDEX `feishu_topic_bindings_device_thread_idx` ON `feishu_topic_bindings` (`device_id`,`codex_thread_id`);