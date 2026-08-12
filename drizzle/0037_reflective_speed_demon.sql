ALTER TABLE `proxy_requests` ADD `client_thread_id` text;--> statement-breakpoint
ALTER TABLE `proxy_requests` ADD `client_turn_id` text;--> statement-breakpoint
ALTER TABLE `proxy_requests` ADD `bridge_task_id` text;--> statement-breakpoint
ALTER TABLE `proxy_requests` ADD `bridge_route_action` text;--> statement-breakpoint
ALTER TABLE `proxy_requests` ADD `bridge_continuation_number` integer;--> statement-breakpoint
CREATE INDEX `proxy_requests_thread_created_at_idx` ON `proxy_requests` (`client_thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `proxy_requests_bridge_task_created_at_idx` ON `proxy_requests` (`bridge_task_id`,`created_at`);