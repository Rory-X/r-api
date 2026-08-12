ALTER TABLE `interaction_adapters` ADD `device_id` text REFERENCES local_connector_devices(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `interaction_adapters_device_enabled_kind_idx` ON `interaction_adapters` (`device_id`,`enabled`,`kind`);
