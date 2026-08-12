ALTER TABLE `proxy_debug_attempts` ADD `attempt_id` text;--> statement-breakpoint
CREATE INDEX `proxy_debug_attempts_attempt_id_idx` ON `proxy_debug_attempts` (`attempt_id`);--> statement-breakpoint
ALTER TABLE `proxy_debug_traces` ADD `request_id` text;--> statement-breakpoint
CREATE INDEX `proxy_debug_traces_request_id_idx` ON `proxy_debug_traces` (`request_id`);--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `attempt_id` text;--> statement-breakpoint
CREATE INDEX `proxy_logs_request_id_created_at_idx` ON `proxy_logs` (`request_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `proxy_logs_attempt_id_created_at_idx` ON `proxy_logs` (`attempt_id`,`created_at`);